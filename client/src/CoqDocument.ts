'use strict';

import * as vscode from 'vscode';
import { workspace, TextEditor, TextEditorEdit, Disposable, ExtensionContext } from 'vscode';
import { LanguageClient } from 'vscode-languageclient';


import {Highlights} from './Highlights';
import {CoqView, SimpleCoqView} from './SimpleCoqView';
import {MDCoqView} from './MDCoqView';
import {HtmlCoqView} from './HtmlCoqView';
import {HtmlLtacProf} from './HtmlLtacProf';
import * as proto from './protocol';
import * as textUtil from './text-util';
import {CoqLanguageServer} from './CoqLanguageServer';
import {adjacentPane} from './CoqView';
import {StatusBar} from './StatusBar';

export class CoqDocument implements vscode.Disposable {
  private statusBar: StatusBar;
  public documentUri: string;
  public highlights = new Highlights();
  private viewDoc: vscode.TextDocument = null;
  private langServer: CoqLanguageServer;
  private view : CoqView;
  private infoOut: vscode.OutputChannel;
  private queryOut: vscode.OutputChannel;
  private noticeOut: vscode.OutputChannel;
  private cursorUnmovedSinceCommandInitiated = new Set<vscode.TextEditor>();

  constructor(uri: vscode.Uri, context: ExtensionContext) {
    this.statusBar = new StatusBar();

    this.documentUri = uri.toString();
    this.langServer = new CoqLanguageServer(context);

    this.infoOut = vscode.window.createOutputChannel('Info');
    this.queryOut = vscode.window.createOutputChannel('Query Results');
    this.noticeOut = vscode.window.createOutputChannel('Notices');
    
    this.view = new HtmlCoqView(uri, context);
    // this.view = new SimpleCoqView(uri.toString());
    // this.view = new MDCoqView(uri);
    this.view.show(true,adjacentPane(this.currentViewColumn()));

    this.langServer.onUpdateHighlights((p) => this.onDidUpdateHighlights(p));
    this.langServer.onMessage((p) => this.onCoqMessage(p));
    this.langServer.onReset((p) => { if (p.uri == this.documentUri) this.onCoqReset(); });
    this.langServer.onUpdateStateViewUrl((p) => { if (p.uri == this.documentUri) this.updateStateViewUrl(p.stateUrl); });
    this.langServer.onUpdateComputingStatus((p) => { if (p.uri == this.documentUri) this.onUpdateComputingStatus(p); });
    this.langServer.onLtacProfResults((p) => { if (p.uri == this.documentUri) this.onLtacProfResults(p); });

    context.subscriptions.push(this.langServer.start());

    this.view.onresize = async (columns:number) => {
      await this.langServer.resizeView(this.documentUri,Math.floor(columns));
      const value = await this.langServer.getGoal(this.documentUri);
      this.view.update(value);
    };

    vscode.window.onDidChangeTextEditorSelection((e:vscode.TextEditorSelectionChangeEvent) => {
      if(this.cursorUnmovedSinceCommandInitiated.has(e.textEditor))
        this.cursorUnmovedSinceCommandInitiated.delete(e.textEditor);
    })
    
    if(vscode.window.activeTextEditor.document.uri.toString() == this.documentUri)
      this.statusBar.focus();
    this.statusBar.setStateReady();
  }
  
  private updateStateViewUrl(stateUrl: string) {
    // if(this.view)
    //   this.view.dispose();
    // this.view = new HttpCoqView(vscode.Uri.parse(this.documentUri), stateUrl);
  }


  public getUri() {
    return this.documentUri;
  }

  dispose() {
    this.statusBar.dispose();
    this.view.dispose();
  }

  private reset() {
    this.highlights.clearAllHighlights(this.allEditors())
  }

  private rememberCursors() {
    this.cursorUnmovedSinceCommandInitiated.clear();
    for(let editor of this.allEditors()) {
      this.cursorUnmovedSinceCommandInitiated.add(editor);    
    }
  }

  private onDidUpdateHighlights(params: proto.NotifyHighlightParams) {
    this.allEditors()
      .forEach((editor) => this.updateHighlights(editor,params));
  }
  
  
  private onUpdateComputingStatus(params: proto.NotifyComputingStatusParams) {
    this.statusBar.setStateComputing(params.status, params.computeTimeMS);
  }
  
  private onCoqMessage(params: proto.NotifyMessageParams) {
    switch(params.level) {
    case 'warning':
      // vscode.window.showWarningMessage(params.message); return;
      this.infoOut.show(true);
      this.infoOut.appendLine(params.message);
    case 'info':
      // this.infoOut.appendLine(params.message); return;
      // this.view.message(params.message);
      this.infoOut.show(true);
      this.infoOut.appendLine(params.message);
      return;
    case 'notice':
      this.noticeOut.clear();
      this.noticeOut.show(true);
      this.noticeOut.append(params.message);
      return;
      // vscode.window.showInformationMessage(params.message); return;
    case 'error':
      vscode.window.showErrorMessage(params.message); return;
    }
  }


  public onDidChangeTextDocument(params: vscode.TextDocumentChangeEvent) {
    for (const change of params.contentChanges) {
      const changeRange = textUtil.toRangeDelta(change.range, change.text);
      this.highlights.applyEdit(changeRange);
    }
  }

  public updateHighlights(editor : vscode.TextEditor, params: proto.NotifyHighlightParams) {
    this.highlights.updateHighlights(this.allEditors(),params);
  }

  public async interruptCoq() {
    this.statusBar.setStateWorking('Killing CoqTop');
    try {
      await this.langServer.interruptCoq(this.documentUri);
    } finally {}
    this.statusBar.setStateReady();
  }

  public async quitCoq(editor: TextEditor) {
    this.statusBar.setStateWorking('Killing CoqTop');
    try {
      await this.langServer.quitCoq(this.documentUri);
    } finally {}
    this.reset();
    this.statusBar.setStateReady();
  }

  public async resetCoq(editor: TextEditor) {
    this.statusBar.setStateWorking('Resetting Coq');
    try {
      await this.langServer.resetCoq(this.documentUri);
    } finally {}
    this.reset();
    this.statusBar.setStateReady();
  }
  
  private findEditor() : vscode.TextEditor {
    return vscode.window.visibleTextEditors.find((editor,i,a) => 
      editor.document.uri.toString() === this.documentUri);
  }

  public allEditors() : vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((editor,i,a) => 
      editor.document.uri.toString() === this.documentUri)
  }

  private currentViewColumn() {
    let editor = this.findEditor();
    if(editor)
      return editor.viewColumn;
    else
      return vscode.window.activeTextEditor.viewColumn;
  }
  
  private onCoqReset() {
    this.reset();
    this.statusBar.setStateReady();
  }

  public async stepForward(editor: TextEditor) {
    this.statusBar.setStateWorking('Stepping forward');
    try {
      this.rememberCursors();
      const value = await this.langServer.stepForward(this.documentUri);
      this.view.update(value);
      if(value.type !== 'not-running')
        for(let editor of this.cursorUnmovedSinceCommandInitiated)
          editor.selections = [new vscode.Selection(value.focus.line,value.focus.character,value.focus.line,value.focus.character)]
    } catch (err) {
    }
    this.statusBar.setStateReady();
  }

  public async stepBackward(editor: TextEditor) {
    this.statusBar.setStateWorking('Stepping backward');
    try {
      this.rememberCursors();
      const value = await this.langServer.stepBackward(this.documentUri);
      this.view.update(value);
      if(value.type !== 'not-running')
        for(let editor of this.cursorUnmovedSinceCommandInitiated)
          editor.selections = [new vscode.Selection(value.focus.line,value.focus.character,value.focus.line,value.focus.character)]
      // const range = new vscode.Range(editor.document.positionAt(value.commandStart), editor.document.positionAt(value.commandEnd));
      // clearHighlight(editor, range);
    } catch (err) {
    }
    this.statusBar.setStateReady();
  }

  public async interpretToCursorPosition(editor: TextEditor) {
    this.statusBar.setStateWorking('Interpretting to point');
    try {
      if(!editor || editor.document.uri.toString() !== this.documentUri)
       return;
      const value = await this.langServer.interpretToPoint(this.documentUri, editor.document.offsetAt(editor.selection.active));
      this.view.update(value);
    } catch (err) {
    }
    this.statusBar.setStateReady();
  }

  public async interpretToEnd(editor: TextEditor) {
    this.statusBar.setStateWorking('Interpreting to end');
    try {
      const params = { uri: this.documentUri };
      const value = await this.langServer.interpretToEnd(this.documentUri);
      this.view.update(value);
    } catch (err) { }
    this.statusBar.setStateReady();
  }

  public async check(query: string) {
    this.statusBar.setStateWorking('Running query');
    try {
      return await this.langServer.check(this.documentUri, query);
    } catch (err) {
    } finally {
      this.statusBar.setStateReady();
    }
  }
  
  private displayQueryResults(results: proto.CoqTopQueryResult) {
    this.queryOut.clear();
    this.queryOut.show(true);
    this.queryOut.append(results.searchResults);
    
  }
  
  public async locate(query: string) {
    this.statusBar.setStateWorking('Running query');
    try {
      const results = await this.langServer.locate(this.documentUri, query);
      this.displayQueryResults(results);
    } catch (err) {
    } finally {
      this.statusBar.setStateReady();
    }
  }
  
  public async search(query: string) {
    this.statusBar.setStateWorking('Running query');
    try {
      const results = await this.langServer.search(this.documentUri, query);
      this.displayQueryResults(results);
    } catch (err) {
    } finally {
      this.statusBar.setStateReady();
    }
  }
  
  public async searchAbout(query: string) {
    this.statusBar.setStateWorking('Running query');
    try {
      const results = await this.langServer.searchAbout(this.documentUri, query);
      this.displayQueryResults(results);
    } catch (err) {
    } finally {
      this.statusBar.setStateReady();
    }
  }
  
  public async viewGoalState(editor: TextEditor, external: boolean) {
    try {
      if(external) {
        await this.view.showExternal();
      } else
        await this.view.show(true,adjacentPane(editor.viewColumn));
    } catch (err) {}
  }

  public async ltacProfGetResults(editor: TextEditor) {
    this.statusBar.setStateWorking('Running query');
    try {
      if(!editor || editor.document.uri.toString() !== this.documentUri)
       return;
      const offset = editor.document.offsetAt(editor.selection.active);
      const results = await this.langServer.ltacProfGetResults(this.documentUri,offset);
      // const view = new HtmlLtacProf(results); 
      // const out = vscode.window.createOutputChannel("LtacProfiler");
      // results.forEach((value,key) => {
      //     out.appendLine("-----------------------------------");
      //     this.outputLtacProfTreeNode(out, "", key, value);
      //   });
    } catch (err) {
    } finally {
      this.statusBar.setStateReady();
    }
  }
  private onLtacProfResults(params: proto.NotifyLtacProfResultsParams) {
    const view = new HtmlLtacProf(params.results); 
  }

  public async doOnLostFocus() {
    this.statusBar.unfocus();
  }  

  public async doOnFocus(editor: TextEditor) {
    this.highlights.refreshHighlights([editor]);
    this.statusBar.focus();
    // await this.view.show(true);
  }

  public async doOnSwitchActiveEditor(oldEditor: TextEditor, newEditor: TextEditor) {
    this.highlights.refreshHighlights([newEditor]);
  }
}