'use strict';

import * as util from 'util';
import {TextDocument, TextDocumentContentChangeEvent, RemoteConsole, Position, Range, Diagnostic, DiagnosticSeverity} from 'vscode-languageserver';
import {CancellationToken} from 'vscode-jsonrpc';
import {Interrupted, CoqtopError, CallFailure, AddResult, EditAtResult} from './coqtop';
import * as thmProto from './protocol';
import * as coqProto from './coq-proto';
import * as coqParser from './coq-parser';
// import {Sentence, Sentences} from './sentences';
import * as textUtil from './text-util';
import {Mutex} from './Mutex';
import {CancellationSignal, asyncWithTimeout} from './CancellationSignal';
import {AsyncWorkQueue} from './AsyncQueue';
import {richppToMarkdown} from './RichPP';
import {CommandIterator, CoqStateMachine, GoalResult} from './STM';


function rangeToString(r:Range) {return `[${positionToString(r.start)},${positionToString(r.end)})`}
function positionToString(p:Position) {return `{${p.line}@${p.character}}`}

export interface DocumentCallbacks {
  sendHighlightUpdates(highlights: thmProto.Highlight[]) : void;
  sendDiagnostics(diagnostics: Diagnostic[]) : void;
  sendMessage(level: string, message: string, rich_message?: any) : void;
  sendReset() : void;
  sendStateViewUrl(stateUrl: string) : void;
  sendComputingStatus(status: thmProto.ComputingStatus, computeTimeMS: number) : void;
  sendLtacProfResults(results: coqProto.LtacProfResults) : void;
}

enum InteractionLoopStatus {Idle, CoqCommand, TextEdit};

enum StepResult {
  Focused, Unfocused, ExceedsMaxOffset, NoMoreCommands
}


// 'sticky' flag is not yet supported :()
const lineEndingRE = /[^\r\n]*(\r\n|\r|\n)?/;

export class CoqDocument implements TextDocument {
  // TextDocument
  public uri: string;
  public languageId: string = 'coq';
  public version: number;
  public getText() {
    return this.documentText;
  }
  public lineCount: number;


  private stm: CoqStateMachine;
  private clientConsole: RemoteConsole;
  // private document: TextDocument;
  private callbacks : DocumentCallbacks;
  private diagnostics : Diagnostic[] = [];
  private documentText: string;
  private processingLock = new Mutex();
  private resettingLock = new Mutex();
  private cancelProcessing = new CancellationSignal();
  private coqtopSettings : thmProto.CoqTopSettings;
  // private interactionCommands = new AsyncWorkQueue();
  // private interactionLoopStatus = InteractionLoopStatus.Idle;
  // we'll use this as a callback, so protect it with an arrow function so it gets the correct "this" pointer

  constructor(coqtopSettings : thmProto.CoqTopSettings, uri: string, text: string, clientConsole: RemoteConsole, callbacks: DocumentCallbacks) {
    this.clientConsole = clientConsole;
    this.documentText = text;
    this.uri = uri;
    this.callbacks = callbacks;
    this.coqtopSettings = coqtopSettings;

    this.resetCoq();
    // this.reset();
    
    // Start a worker to handle incomming commands and text edits in a sequential manner
    // this.interactionLoop();
  }


  private applyEditToDocument(begin: number, change: TextDocumentContentChangeEvent) : void {
    this.documentText =
      this.documentText.substring(0,begin)
      + change.text
      + this.documentText.substring(begin+change.rangeLength);
  }
  
  private getTextOfRange(range: Range) {
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    return this.documentText.substring(start,end);
  }


  public async applyTextEdits(changes: TextDocumentContentChangeEvent[], newVersion: number) {
    // sort the edits such that later edits are processed first
    let sortedChanges =
      changes.sort((change1,change2) =>
        textUtil.positionIsAfter(change1.range.start, change2.range.start) ? -1 : 1)

    try {
      await this.stm.applyChanges(sortedChanges, newVersion);
    } catch (err) {
      this.clientConsole.error("STM crashed while applying text edit: " + err.toString())
    }

    for(const change of sortedChanges) {
      // this.clientConsole.log(`Change: ${rangeToString(change.range)} (${change.rangeLength}) --> ${change.text}`);
      // Remove diagnostics for any text that has been modified
      // this.removeDiagnosticsIntersecting(change.range, false);

      // Find offsets for change-range
      const beginOffset = this.offsetAt(change.range.start);

      this.applyEditToDocument(beginOffset, change);
      
      // And also adjust the diagnostic locations
      // this.shiftDiagnostics(textUtil.toRangeDelta(change.range, change.text));
    }

    this.version = newVersion;


    // send the updated diagnostics
// TODO
    // this.callbacks.sendDiagnostics(this.diagnostics);
  }
  
  public offsetAt(pos: Position) : number {
    return textUtil.offsetAt(this.documentText,pos);
  }

  /**
   * @returns the Position (line, column) for the location (character position)
   */
  public positionAt(offset: number) : Position {
    return textUtil.positionAt(this.documentText, offset);
  }

  
  private sentenceStatusToHighlightType(status: coqProto.SentenceStatus) : thmProto.HighlightType {
    switch(status) {
      case coqProto.SentenceStatus.Complete:
        return thmProto.HighlightType.Complete;
      case coqProto.SentenceStatus.Incomplete:
        return thmProto.HighlightType.Incomplete;
      case coqProto.SentenceStatus.InProgress:
        return thmProto.HighlightType.InProgress;
      case coqProto.SentenceStatus.Parsed:
        return thmProto.HighlightType.Parsing;
      case coqProto.SentenceStatus.Processed:
        return thmProto.HighlightType.Processed;
      case coqProto.SentenceStatus.ProcessingInput:
        return thmProto.HighlightType.Processing;
    }    
  }

  private highlightTypeToSentenceStatus(type: thmProto.HighlightType) : coqProto.SentenceStatus {
    switch(type) {
      case thmProto.HighlightType.Complete:
        return coqProto.SentenceStatus.Complete;
      case thmProto.HighlightType.Incomplete:
        return coqProto.SentenceStatus.Incomplete;
      case thmProto.HighlightType.InProgress:
        return coqProto.SentenceStatus.InProgress;
      case thmProto.HighlightType.Parsing:
        return coqProto.SentenceStatus.Parsed;
      case thmProto.HighlightType.Processed:
        return coqProto.SentenceStatus.Processed;
      case thmProto.HighlightType.Processing:
        return coqProto.SentenceStatus.ProcessingInput;
      default:
        throw `Cannot convert ${thmProto.HighlightType[type]} to a SentenceStatus`
    }    
  }
  
  private highlightSentence(sentence: Range, type: thmProto.HighlightType) : thmProto.Highlight {
    // if(type===undefined)
    //     type = this.sentenceStatusToHighlightType(sentence.status);
    return { style: type, range: sentence };
  }

  /** creates the current highlights from scratch */
  private createHighlights() {
    let highlights : thmProto.Highlight[] = [];
    for(let sent of this.stm.getSentences()) {
      this.highlightSentence(sent.range, this.sentenceStatusToHighlightType(sent.status));
    }
    return highlights;
  }

  /** creates the current diagnostics from scratch */
  private createDiagnostics() {
    let diagnostics : Diagnostic[] = [];
    for(let error of this.stm.getSentenceErrors()) {
      diagnostics.push(
        { message: error.message
        , range: error.range
        , severity: DiagnosticSeverity.Error
        , source: 'coq'
        })
    }
    return diagnostics;
  }

  private onCoqStateStatusUpdate(range: Range, status: coqProto.SentenceStatus) {
    this.callbacks.sendHighlightUpdates(
      [ this.highlightSentence(range, this.sentenceStatusToHighlightType(status))
      ]);
  }
  
  private onClearSentence(range: Range) {
    this.callbacks.sendHighlightUpdates(
      [ this.highlightSentence(range, thmProto.HighlightType.Clear)
      ]);
  }

  private onCoqStateError(sentenceRange: Range, errorRange: Range, message: string, rich_message?: any) {
    this.callbacks.sendHighlightUpdates(
      [ this.highlightSentence(sentenceRange, thmProto.HighlightType.TacticFailure)
      ]);

    this.updateDiagnostics()
    // this.addDiagnostic(
    //   { message: message
    //   , range: errorRange
    //   , severity: DiagnosticSeverity.Error
    //   });
  }
  
  
  private onCoqMessage(level: coqProto.MessageLevel, message: string, rich_message?: any) {
    this.callbacks.sendMessage(coqProto.MessageLevel[level], message, rich_message);
  }

  private onCoqStateLtacProf(range: Range, results: coqProto.LtacProfResults) {
    this.callbacks.sendLtacProfResults(results);
  }
  
  private async onCoqDied(error?: string) {
    if(!error)
      return;
    this.resetCoq();
    this.callbacks.sendReset();
  }

  public async resetCoq() {
    if(this.stm && this.stm.isRunning())
      this.stm.shutdown(); // Don't bother awaiting
    this.stm = new CoqStateMachine(this.coqtopSettings, {
      sentenceStatusUpdate: (x1,x2) => this.onCoqStateStatusUpdate(x1,x2),
      clearSentence: (x1) => this.onClearSentence(x1),
      error: (x1,x2,x3) => this.onCoqStateError(x1,x2,x3),
      message: (x1,x2,x3) => this.onCoqMessage(x1,x2,x3),
      ltacProfResults: (x1,x2) => this.onCoqStateLtacProf(x1,x2),
      coqDied: (error?: string) => this.onCoqDied(error),
    }, this.clientConsole);
  }
  
  
  // private async cancellableOperation<T>(operation: Thenable<T>) : Promise<T> {
  //   return await Promise.race<T>(
  //     [ operation
  //     , this.cancelProcessing.event.then(() => Promise.reject<T>('operation cancelled'))
  //     ]);
  // }

  /** generates a list of contiguous commands
   * @param begin: where to start parsing commands
   * @param endOffset: if specified, stop at the last command to not exceed the offset
   */
  private *commandSequenceGenerator(begin: Position, end?: Position, highlight: boolean = false) : IterableIterator<{text: string, range: Range}> {
    let endOffset : number;
    if(end == undefined)
      endOffset = this.documentText.length;
    else
      endOffset = Math.min(this.offsetAt(end), this.documentText.length);

    let currentOffset = this.offsetAt(begin);
    if(currentOffset >= endOffset)
      return;

    while(true) {
      const commandLength = coqParser.parseSentence(this.documentText.substr(currentOffset, endOffset))
      const nextOffset = currentOffset + commandLength;
      if(commandLength > 0 || nextOffset > endOffset) {
        let result =
          { text: this.documentText.substring(currentOffset, nextOffset)
          , range: Range.create(this.positionAt(currentOffset),this.positionAt(nextOffset))
          };
        yield result;
        // only highlight if the command was accepted (i.e. another is going to be request; i.e. after yield)
        if (highlight) {// Preliminary "parsing" highlight
          const parsingHighlights : thmProto.Highlight[] = [
            { style: thmProto.HighlightType.Parsing, range: result.range }
            ];
          this.callbacks.sendHighlightUpdates(parsingHighlights);
        }
      } else
        return;
      currentOffset = nextOffset; 
    }
  }

  private commandSequence(highlight=false) {
    return (begin,end?) => this.commandSequenceGenerator(begin,end);
  }

  // /**
  //  * @param currentSentence: where to start parsing the next sentence
  //  * @param maxOffset: do not parse past maxOffset
  //  * @returns the next parsed sentence OR else null if parsing exceeds @maxOffset
  //  */
  // private async plainStepForward(maxOffset?: number) : Promise<StepResult> {
  //   const start = this.stm.getFocusedPosition();
  //   const startOffset = this.offsetAt(start);
  //   const docText = this.documentText;
  //   const sentenceLength = coqParser.parseSentence(this.documentText.substr(startOffset,maxOffset));
  //   if(sentenceLength == -1)
  //     return StepResult.NoMoreCommands;
  //   const stopPos = startOffset + sentenceLength;

  //   if(maxOffset!==undefined && stopPos > maxOffset)
  //     return StepResult.ExceedsMaxOffset;
    
  //   const range = Range.create(start,this.positionAt(stopPos));
  //   let command = docText.substring(startOffset, stopPos);

  //   // Preliminary "parsing" highlight
  //   const parsingHighlights = [
  //     { style: thmProto.HighlightType.Parsing, textBegin: startOffset, textEnd: stopPos }
  //     ];
  //   this.callbacks.sendHighlightUpdates(parsingHighlights);

  //   try {
  //     const unfocused = await this.stm.stepForward(command, range, this.version, true);
  //     return unfocused ? StepResult.Unfocused : StepResult.Focused;
  //   } catch(err) {
  //     const error = <CommandParseError>err;

  //     const highlights = [
  //       { style: thmProto.HighlightType.Clear, textBegin: startOffset, textEnd: stopPos }
  //       // { style: thmProto.HighlightType.SyntaxError, textBegin: errorEnd, textEnd: errorEnd },
  //       ];
  //     this.callbacks.sendHighlightUpdates(highlights);

  //     this.addDiagnostic({
  //       message: error.message,
  //       range: error.range,
  //       severity: DiagnosticSeverity.Error
  //       });

  //     throw error;
  //   }
  // }

  // private async addDiagnostic(diagnostic: Diagnostic) {
  //   const diag = diagnostic;
  //   diag.message = await richppToMarkdown(diag.message);
  //   this.diagnostics.push(diag);
  //   this.callbacks.sendDiagnostics(this.diagnostics);
  // }

  // private removeDiagnosticsContaining(pos: Position, sendUpdate?: boolean) {
  //   this.diagnostics = this.diagnostics
  //     .filter((d) => !textUtil.rangeContains(d.range, pos));
  //   if(sendUpdate === undefined || sendUpdate===true)
  //     this.callbacks.sendDiagnostics(this.diagnostics);
  // }

  // private removeDiagnosticsIntersecting(range: Range, sendUpdate?: boolean) {
  //   this.diagnostics = this.diagnostics
  //     .filter((d) => !textUtil.rangeTouches(d.range, range));
  //   if(sendUpdate === undefined || sendUpdate===true)
  //     this.callbacks.sendDiagnostics(this.diagnostics);
  // }
  

  // private shiftDiagnostics(delta: textUtil.RangeDelta) {
  //   for(let idx = 0; idx < this.diagnostics.length; ++idx) {
  //     this.diagnostics[idx].range = textUtil.rangeTranslate(this.diagnostics[idx].range, delta);
  //   }
  // }
  

  // private clearSentenceHighlight(sentence: Sentence, endSentence?: Sentence) {
  //   this.callbacks.sendHighlightUpdates([{
  //     style: thmProto.HighlightType.Clear,
  //     textBegin: sentence.textBegin,
  //     textEnd: endSentence ? endSentence.textEnd : sentence.textEnd
  //   }]);
  // }

  // private clearSentenceHighlightAfter(sentence: Sentence, endSentence?: Sentence) {
  //   this.callbacks.sendHighlightUpdates([{
  //     style: thmProto.HighlightType.Clear,
  //     textBegin: sentence.textEnd,
  //     textEnd: endSentence ? endSentence.textEnd : sentence.textEnd
  //   }]);
  // }

 
  // /** Interpret to point
  //  * Tell Coq to process the proof script up to the given point
  //  * This may not fully process everything, or it may rewind the state.
  //  */
  // private async interpretToPoint(position: Position) : Promise<thmProto.CoqTopGoalResult> {
  //   try {
  //     do {
  //       const focus = this.stm.getFocusedPosition();
  //       const focusOffset = this.offsetAt(focus);
  //       const offset = this.offsetAt(position);
  //       if(textUtil.positionIsAfterOrEqual(position, focus)) {
  //         // We need to step forward to reach the location.
  //         // We might be focused in the middle of a proof, so even if there is a
  //         // closer state we can jump to, we cannot call coqEditAt just yet.
  //         // (Or else we will get a Coq anomally :/ )
  //         for(let command of this.commandSequence(focus,offset)) {
  //           const focusChanged = this.stm.stepForward(command.text, command.range, this.version, true);
  //           if(focusChanged)
  //             break;
  //         }

  //         // At this point, either we have reached the location we're looking for,
  //         // or else the proof has become unfocused (the current state might be
  //         // anywhere) and we will need to call coqEditAt to get closer to the location.      
  //         const closestSentence = this.sentences.findPrecedingSentence(location);
  //         // Are we at the closest sentence?
  //         if(forwardSentence.stateId !== closestSentence.stateId) {
  //           // No; jump there
  //           await this.jumpToLocation(closestSentence);
  //         }
  //         // We can now step forward directly to the location
  //         return await this.interpretToEnd(location);
  //       } else {
  //         // Our desired location is above us; we'll have to jump there
  //         const closestSentence = this.sentences.findPrecedingSentence(location);
  //         await this.jumpToLocation(closestSentence);
  //         return await this.rawGetGoal();
  //       }
  //     }
  //   } catch(error) {
  //     return this.errorGoalResult(error);
  //   }
  // }


  // private errorGoalResult(error: FailureResult) : thmProto.CoqTopGoalResult {
  //   const e = <coqProto.FailValue>{
  //     message: error.message,
  //     range: error.range
  //     };
  //   return {error: e};
  // }

  // /**
  //  * 
  //  *  */  
  // private async interpretToEnd(maxOffset?: number) : Promise<thmProto.CoqTopGoalResult> {
  //   let currentSentence = this.sentences.getTip();
    
  //   try {
  //     await this.stepForwardUntil(maxOffset);
      
  //     return await this.rawGetGoal();
  //   } catch(error) {
  //     return this.errorGoalResult(error);
  //   }
  // }

//   private async rollbackState(startingSentence: Sentence, endSentence?: Sentence) {
//     if(this.sentences.getTip().stateId !== startingSentence.stateId) {
//       // Undo the sentence
// this.clientConsole.log("rolling back state");
//       await this.coqTop.coqEditAt(startingSentence.stateId);
//       this.sentences.rewindTo(startingSentence);
//       if(endSentence !== undefined)
//         this.clearSentenceHighlightAfter(startingSentence,endSentence);
// this.clientConsole.log("rolled back");
//     }
//   }
  
  
  // private async stepForward() : Promise<thmProto.CoqTopGoalResult> {
  //   const currentSentence = this.sentences.getTip();
  //   try {
  //     const interp = await this.plainStepForward(currentSentence);
  //     if(!interp)
  //       return {}

  //     return await this.rawGetGoal(interp.nextSentence ? interp.nextSentence.stateId : undefined);
  //   } catch(error) {
  //     this.rollbackState(currentSentence);
  //     return this.errorGoalResult(error);
  //   }
  // }
  
  // /**
  //  * 
  //  *  */  
  // private async stepBackward() : Promise<thmProto.CoqTopGoalResult> {
  //   // grab the tip sentence
  //   const currentSentence = this.sentences.getTip();

  //   try {
  //     const prevSentence = this.sentences.getPredecessor(currentSentence);

  //     if(prevSentence == null) {
  //       await this.doResetCoq();
  //       return {};
  //     }

  //     await this.coqTop.coqEditAt(prevSentence.stateId);
  //     this.sentences.rewindTo(prevSentence);
  //     this.callbacks.sendHighlightUpdates([
  //       this.highlightSentence(currentSentence, thmProto.HighlightType.Clear)
  //       ]);
  //     return await this.rawGetGoal(prevSentence.stateId);
  //   } catch(err) {
  //     const error = <FailureResult>err;
  //     const beforeErrorSentence = this.sentences.get(error.stateId);
  //     await this.coqTop.coqEditAt(error.stateId);

  //     this.clearSentenceHighlightAfter(beforeErrorSentence,currentSentence);
  //     this.sentences.rewindTo(beforeErrorSentence);
  //     return await this.getGoal();
  //   }

  // }
  
  public async close() {
    return await this.stm.shutdown();
  }

  // private async protectOperation(op: (wasReset:boolean)=>Promise<thmProto.CoqTopGoalResult>, lazyInitialize?: boolean) : Promise<thmProto.CoqTopGoalResult> {
  //   lazyInitialize = (lazyInitialize===undefined) ? true : false;
  //   let unlock : () => Promise<void>; 
  //   try {
  //     unlock = await this.processingLock.lock(this.cancelProcessing.event);
  //   } catch(reason) {
  //     return <coqProto.FailValue>{message: "operation cancelled"};
  //   }
  //   try {
  //     if(!this.coqTop.isRunning()) {
  //       if(!lazyInitialize)
  //         return {};
  //       await this.cancellableOperation(this.doResetCoq());
  //       const result = await this.cancellableOperation(op(true));
  //     } else
  //       return await this.cancellableOperation(op(false));
  //   } catch(reason) {
  //     return <coqProto.FailValue>{message: reason};
  //   } finally {
  //     unlock();
  //   }
  // }  
  
  // private interrupt() {
  //   this.coqTop.coqInterrupt();
  // }


  // /**
  //  * This loop handles each coq command and text edit sequentially.
  //  * One of the requirements is that a command's document position is still valid when it returns so that we can report accurate error messages, so text edits that arrive while a command is being processed are delayed until the command finished so that we do not invalidate its document positions.
  //  * 
  //  * To cancel the current queue of commands, call cancelCoqOperations()  
  //  */
  // private async interactionLoop() {
  //   while(true) {
  //     try {
  //       await this.interactionCommands.executeOneTask();
  //     } catch(error) {
  //       this.clientConsole.warn(`Interaction loop exception: ${error}`);
  //     } finally {
  //     }
  //   }
  // }
  
  // /**
  //  * Ensures that the text edits are applied *after* the currently scheduled operations; this delay prevents their document positions from being invalidated too soon
  //  * However, if the edit will result in changing an already-interpreted sentence, then all current Coq processing will be cancelled.
  //  * Text edits themselves cannot be cancelled, but the Coq operations they may perform to set the current editing positions *can* be cancelled. 
  //  */
  // public textEdit(changes: TextDocumentContentChangeEvent[]) {
  //   // If any of the edits affect an interpreted sentence, then interrupt and cancel all Coq operations
  //   for(const change of changes) {
  //     const beginOffset = this.offsetAt(change.range.start);
  //     const endOffset = beginOffset + change.rangeLength;
  //     // Have any sentences been edited?
  //     const rangeSent = this.sentences.getRangeAffected(beginOffset,endOffset);

  //     if(!this.isPassiveEdit(rangeSent,change, beginOffset, endOffset) && rangeSent.length) {
  //       //this.clientConsole.info("Cancelling current Coq operations due to editing text of interpreted statements.");
  //       this.cancelCoqOperations();
  //       break;
  //     }
  //   }    
  //   const cancelSignal = this.cancelProcessing;
  //   return this.interactionCommands.process<void>(async () => {
  //     this.interactionLoopStatus = InteractionLoopStatus.TextEdit;
  //     try {
  //       // applyTextEdits will check for a cancellation signal during Coq calls, but text-editing itself should never be cancelled
  //       return await this.applyTextEdits(changes, cancelSignal);
  //     } finally {
  //       this.interactionLoopStatus = InteractionLoopStatus.Idle;
  //     }
  //   });
  // }


  private updateComputingStatus(status: thmProto.ComputingStatus, startTime: [number,number]) {
    const duration = process.hrtime(startTime);
    const interval = duration[0] * 1000.0 + (duration[1] / 1000000.0);
    this.callbacks.sendComputingStatus(status, interval);
  }

  // private async doCoqOperation<X>(task: ()=>Promise<X>, lazyInitializeCoq? : boolean) {
  //   lazyInitializeCoq = (lazyInitializeCoq===undefined) ? true : lazyInitializeCoq;
  //   if(!this.coqTop.isRunning()) {
  //     if(lazyInitializeCoq) {
  //       await this.doResetCoq();
  //     } else
  //       return {};
  //   }
    
  //   return await task();
  // }

  // private enqueueCoqOperation<X>(task: ()=>Promise<X>, lazyInitializeCoq? : boolean) {
  //   // this.cancelProcessing might change in the future, so we want to make sure that, when
  //   // the task is eventually run, it will use the CURRENT this.cancelProcessing
  //   const cancelSignal = this.cancelProcessing;
  //   return this.interactionCommands.process<X>(async () => {
  //     if(cancelSignal.isCancelled())
  //       return Promise.reject<X>(<coqProto.FailValue>{message: 'operation cancelled'})
        
  //     this.interactionLoopStatus = InteractionLoopStatus.CoqCommand;
  //     const startTime = process.hrtime();
  //     const statusCheck = setInterval(() => this.updateComputingStatus(thmProto.ComputingStatus.Computing, startTime), 500);
  //     var interrupted = false;
  //     try {
  //       return await Promise.race<X>(
  //         [ this.doCoqOperation(task, lazyInitializeCoq)
  //         , cancelSignal.event.then(() => Promise.reject<X>(<coqProto.FailValue>{message: 'operation cancelled'}))
  //         ]);
  //     } catch(error) {
  //       this.updateComputingStatus(thmProto.ComputingStatus.Interrupted, startTime);
  //       interrupted = true;
  //       throw error;
  //     } finally {
  //       this.interactionLoopStatus = InteractionLoopStatus.Idle;
  //       clearInterval(statusCheck);
  //       if(!interrupted)
  //         this.updateComputingStatus(thmProto.ComputingStatus.Finished, startTime);
  //     }
  //   });
  // }
  
  // /**
  //  * Cancels all coq commands that are associated with `cancelProcessing`, which should be every coq command in `interactionCommands`.
  //  * If a text edit invalidates a state, then this method should also be called.
  //  */
  // private cancelCoqOperations() : Promise<void> {
  //   // Cancel all current and pending operations
  //   this.cancelProcessing.cancel();
  //   // Do not cancel subsequent operations
  //   this.cancelProcessing = new CancellationSignal();
  //   if(this.interactionLoopStatus === InteractionLoopStatus.CoqCommand)
  //     return this.coqTop.coqInterrupt();
  // }
  
  // private async interactionsCoqQuit() {
  //   const waitMS = 1000;
  //   const cancelling = this.cancelCoqOperations();
  //   try {
  //     await Promise.race<{}>([cancelling, new Promise((resolve,reject) => setTimeout(() => reject(), waitMS))]);
  //   } finally {
  //     await this.coqTop.coqQuit();
  //   }
  // }
  
  // private async interactionsCoqReset() {
  //   const waitMS = 1000;
  //   const cancelling = this.cancelCoqOperations();
  //   try {
  //     await Promise.race<{}>([cancelling, new Promise((resolve,reject) => setTimeout(() => reject(), waitMS))]);
  //   } finally {
  //     await this.doResetCoq();
  //   }
  // }

  /** Make sure that the STM is running */
  private assertStm() {
    if(!this.stm || !this.stm.isRunning())
      this.resetCoq();
  }

  // private convertErrorToCommandResult(error: any) : thmProto.FailureResult {
  //   if(error instanceof Interrupted) {
  //     return undefined;
  //   } else if(error instanceof CoqtopError) {
  //   } else if(error instanceof CallFailure) {
  //     return Object.assign<thmProto.FailureResult,thmProto.FocusPosition>({type: 'failure', message: error.message, range: error.range, sentence: error.stateId}, {focus: this.stm.getFocusedPosition()})
  //   else
  //     throw error;
  // }

  private toGoal(goal: GoalResult) : thmProto.CommandResult {
    if(goal.type === 'not-running')
      return goal
    // This is silly (Typescript is not yet smart enough)
    else if(goal.type === 'proof-view')
      return Object.assign(goal,<thmProto.FocusPosition>{focus: this.stm.getFocusedPosition()});
    else if(goal.type === 'no-proof')
      return Object.assign(goal,<thmProto.FocusPosition>{focus: this.stm.getFocusedPosition()});
    else if(goal.type === 'failure')
      return Object.assign(goal,<thmProto.FocusPosition>{focus: this.stm.getFocusedPosition()});
    else if(goal.type === 'interrupted')
      return Object.assign(goal,<thmProto.FocusPosition>{focus: this.stm.getFocusedPosition()});

  //     export type GoalResult = proto.NoProofTag | proto.NotRunningTag |
  // (proto.FailValue & proto.FailureTag) |
  // (proto.ProofView & proto.ProofViewTag) |
  // (proto.CommandInterrupted & proto.InterruptedTag)


//   export type FocusPosition = {focus: vscode.Position}
// export type NotRunningTag = {type: 'not-running'}
// export type NoProofTag = {type: 'no-proof'}
// export type FailureTag = {type: 'failure'}
// export type ProofViewTag = {type: 'proof-view'}
// export type InterruptedTag = {type: 'interrupted'}
// export type NotRunningResult = NotRunningTag
// export type NoProofResult = NoProofTag & FocusPosition
// export type FailureResult = FailValue & FailureTag & FocusPosition
// export type ProofViewResult = ProofView & ProofViewTag & FocusPosition
// export type InterruptedResult = CommandInterrupted & InterruptedTag & FocusPosition
// export type CommandResult = NotRunningTag | FailureResult | ProofViewResult | InterruptedResult | NoProofResult
  }

  private updateDiagnostics() {
    const diagnostics : Diagnostic[] = [];
    for(let error of this.stm.getErrors()) {
      // this.clientConsole.log(error.message + '  @' + textUtil.rangeToString(error.range) + ' -- of ' + textUtil.rangeToString(error.sentence));
      diagnostics.push(Diagnostic.create(error.range,error.message,DiagnosticSeverity.Error,undefined,'coqtop'))
    }
    this.callbacks.sendDiagnostics(diagnostics);
  }


  public async stepForward(token: CancellationToken) : Promise<thmProto.CommandResult> {
    this.assertStm();
    try {
    //   const parsingHighlights = [
    //     { style: thmProto.HighlightType.Parsing, textBegin: startOffset, textEnd: stopPos }
    //     ];
    //   this.callbacks.sendHighlightUpdates(parsingHighlights);
      const error = await this.stm.stepForward(this.commandSequence(true));
      if(error)
        return error
  this.stm.logDebuggingSentences();
      return this.toGoal(await this.stm.getGoal());
    } finally {
      this.updateDiagnostics();
    }
  }

  public async stepBackward(token: CancellationToken) : Promise<thmProto.CommandResult> {
    this.assertStm();
    try {
    await this.stm.stepBackward();
this.stm.logDebuggingSentences();
    return this.toGoal(await this.stm.getGoal());
    } finally {
      this.updateDiagnostics();
    }
  }

  public async interpretToPoint(offset: number, token: CancellationToken) : Promise<thmProto.CommandResult> {
    this.assertStm();
    try {
      const pos = this.positionAt(offset);
      const parsingHighlights : thmProto.Highlight[] = [
        { style: thmProto.HighlightType.Parsing, range: Range.create(this.stm.getFocusedPosition(),pos) }
        ];
      this.callbacks.sendHighlightUpdates(parsingHighlights);
      const error = await this.stm.interpretToPoint(pos,this.commandSequence(false), token);
      if(error)
        return error;
  this.stm.logDebuggingSentences();
      return this.toGoal(await this.stm.getGoal());
    } finally {
      this.updateDiagnostics();
    }

  }

  public async interpretToEnd(token: CancellationToken) : Promise<thmProto.CommandResult> {
    this.assertStm();
    try {
      const error = await this.interpretToPoint(this.documentText.length,token);
      if(error)
        return error;
  this.stm.logDebuggingSentences();
      return this.toGoal(await this.stm.getGoal());
    } finally {
      this.updateDiagnostics();
    }
  }

  public async getGoal() : Promise<thmProto.CommandResult> {
    if(!this.stm || !this.stm.isRunning())
      return {type: 'not-running'};
    try {
      return this.toGoal(await this.stm.getGoal());
    } finally {
      this.updateDiagnostics();
    }

  }

  public async locateIdent(ident: string) {
    if(!this.stm || !this.stm.isRunning())
      return "Coq is not running";
    return await this.stm.doQuery(`Locate ${ident}.`);
  }

  public async checkTerm(term: string) {
    if(!this.stm || !this.stm.isRunning())
      return "Coq is not running";
    return await this.stm.doQuery(`Check ${term}.`);
  }

  public async search(query: string) {
    if(!this.stm || !this.stm.isRunning())
      return "Coq is not running";
    return await this.stm.doQuery(`Search ${query}.`);
  }

  public async searchAbout(query: string) {
    if(!this.stm || !this.stm.isRunning())
      return "Coq is not running";
    return await this.stm.doQuery(`SearchAbout ${query}.`);
  }

  public async setWrappingWidth(columns: number) {
    if(!this.stm || !this.stm.isRunning())
      return;
    
    await this.stm.setWrappingWidth(columns);
  }

  public async requestLtacProfResults(offset?: number) {
    if(!this.stm || !this.stm.isRunning())
      return;
    await this.stm.requestLtacProfResults(offset ? this.positionAt(offset) : undefined);
  }

  public async interrupt() {
    if(!this.stm || !this.stm.isRunning())
      return;
    this.stm.interrupt();
  }

  public async quitCoq() {
    if(!this.stm || !this.stm.isRunning())
      return;
    await this.stm.shutdown();
    this.stm.dispose();
    this.stm = null;
  }

  // private coqInterface = {
  //     stepForward: () => this.enqueueCoqOperation(async () => await this.stepForward(), true),
  //     stepBackward: () => this.enqueueCoqOperation(() => this.stepBackward(), true),
  //     interpretToPoint: (offset) => this.enqueueCoqOperation(() => this.interpretToPoint(offset), true),
  //     interpretToEnd: () => this.enqueueCoqOperation(() => this.interpretToEnd(), true),
  //     getGoals: () => this.enqueueCoqOperation(() => this.getGoal(), true),
  //     locate: (query: string) => this.enqueueCoqOperation(async () => ({searchResults: await this.coqTop.coqQuery("Locate " + query + ".")}), true),
  //     check: (query: string) => this.enqueueCoqOperation(async () => ({searchResults: await this.coqTop.coqQuery("Check " + query + ".")}), true),
  //     search: (query: string) => this.enqueueCoqOperation(async () => ({searchResults: await this.coqTop.coqQuery("Search " + query + ".")}), true),
  //     searchAbout: (query: string) => this.enqueueCoqOperation(async () => ({searchResults: await this.coqTop.coqQuery("SearchAbout " + query + ".")}), true),
  //     resizeWindow: (columns: number) => this.enqueueCoqOperation(() => this.coqTop.coqResizeWindow(columns), false),
  //     ltacProfResults: (offset?: number) => this.enqueueCoqOperation(async () => {
  //       if(offset) {
  //         const sent = this.sentences.findAtTextPosition(offset);
  //         return this.coqTop.coqLtacProfilingResults(sent===null ? undefined : sent.stateId);
  //       } else
  //         return this.coqTop.coqLtacProfilingResults();
  //     }, true),
  //     quit: () => this.interactionsCoqQuit(),
  //     reset: () => this.interactionsCoqReset(),
  //     interrupt: () => this.cancelCoqOperations(),
  //   };
  // private coqInterface = {
  //     stepForward: () => this.protectOperation((wasReset) => this.stepForward()),
  //     stepBackward: () => this.protectOperation((wasReset) => this.stepBackward()),
  //     interpretToPoint: (offset) => this.protectOperation((wasReset) => this.editAt(offset)),
  //     interpretToEnd: () => this.protectOperation((wasReset) => this.interpretToEnd()),
  //     getGoals: () => this.protectOperation(async (wasReset) => this.getGoal()),
  //     quit: () => {this.coqTop.coqQuit(); return {}},
  //     reset: () => this.doResetCoq(),
  //     interrupt: () => {
  //       if(this.processingLock.isLocked())
  //         this.coqTop.coqInterrupt();
  //     },
  //     locate: (query: string) => this.protectOperation((wasReset) => this.coqTop.coqQuery("Locate " + query + ".")),
  //     check: (query: string) => this.protectOperation((wasReset) => this.coqTop.coqQuery("Check " + query + ".")),
  //     search: (query: string) => this.protectOperation((wasReset) => this.coqTop.coqQuery("Search " + query + ".")),
  //     searchAbout: (query: string) => this.protectOperation((wasReset) => this.coqTop.coqQuery("SearchAbout " + query + ".")),
  //     resizeWindow: (columns: number) => this.coqTop.coqResizeWindow(columns),
  //   };
  
  // public get coq() {
  //   return this.coqInterface; 
  // }
}


