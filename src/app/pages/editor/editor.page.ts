import { ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActionSheetController, AlertController, ToastController } from '@ionic/angular/standalone';
import { App } from '@capacitor/app';
import type * as Monaco from 'monaco-editor';
import { FilesystemService, FsNode } from '../../services/filesystem.service';
import { AiVisionService, ChatMessage, DiffLine, AiFix, VisionContext } from '../../services/ai-vision.service';

interface Tab { path: string; name: string; dirty: boolean; }
interface Doc { model: Monaco.editor.ITextModel; savedVersion: number; }
interface Row { node: FsNode; depth: number; }
interface TermLine { level: 'log' | 'info' | 'warn' | 'error' | 'cmd' | 'sys'; text: string; }

const LANG_BY_EXT: Record<string, string> = {
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python',
  md: 'markdown', xml: 'xml', yml: 'yaml', yaml: 'yaml', txt: 'plaintext', sh: 'shell'
};

/** Injected into preview/run iframes: forwards console + errors to the Zeno terminal. */
const CONSOLE_HOOK = `(function(){
var p=function(l,a){try{parent.postMessage({zeno:1,level:l,text:Array.prototype.map.call(a,function(x){try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ')},'*')}catch(e){}};
['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){p(k==='debug'?'log':k,arguments);try{o&&o.apply(console,arguments)}catch(e){}}});
window.addEventListener('error',function(e){p('error',[e.message+(e.lineno?' (line '+e.lineno+')':'')])});
window.addEventListener('unhandledrejection',function(e){p('error',['Unhandled: '+((e.reason&&e.reason.message)||e.reason)])});
})();`;

const REPL_LISTENER = `window.addEventListener('message',function(e){if(e.data&&e.data.zenoEval!==undefined){try{var r=(0,eval)(e.data.zenoEval);if(r!==undefined)console.log(r)}catch(err){console.error(err&&err.stack?err.stack:String(err))}}});`;

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './editor.page.html',
  styleUrls: ['./editor.page.scss'],
  host: { class: 'ion-page' }
})
export class EditorPage implements OnInit, OnDestroy {
  @ViewChild('editorHost', { static: true }) editorHost!: ElementRef<HTMLDivElement>;
  @ViewChild('previewFrame', { static: true }) previewFrame!: ElementRef<HTMLIFrameElement>;
  @ViewChild('termBox') termBox?: ElementRef<HTMLDivElement>;
  @ViewChild('chatBox') chatBox?: ElementRef<HTMLDivElement>;

  /* ---- state ---- */
  project = '';
  projects: string[] = [];
  tree: FsNode[] = [];
  rows: Row[] = [];
  expanded = new Set<string>();
  selectedDir = '';
  tabs: Tab[] = [];
  activePath = '';
  loading = true;
  storageLabel = '';

  sidebarOpen = false;
  aiOpen = false;
  settingsOpen = false;
  isWide = false;
  autoSave = true;

  panelOpen = false;
  panelTab: 'terminal' | 'preview' = 'terminal';
  panelFull = false;
  termLines: TermLine[] = [];
  termInput = '';
  termHistory: string[] = [];
  termHistIdx = -1;

  aiInput = '';
  settingsDraft = { apiKey: '', endpoint: '', model: '' };

  /* ---- internals ---- */
  private monaco!: typeof Monaco;
  private editor!: Monaco.editor.IStandaloneCodeEditor;
  private docs = new Map<string, Doc>();
  private autoSaveTimer: any;
  private previewTimer: any;
  private runFrame: HTMLIFrameElement | null = null;
  private replFrame: HTMLIFrameElement | null = null;
  private pyodide: any = null;
  private pyodideLoading: Promise<any> | null = null;
  private touchStart: { x: number; y: number } | null = null;
  private diffCache = new WeakMap<AiFix, DiffLine[]>();
  private subs: Array<{ unsubscribe(): void }> = [];
  private backHandle: { remove(): Promise<void> } | null = null;
  private msgListener = (e: MessageEvent) => this.onFrameMessage(e);

  constructor(
    public ai: AiVisionService,
    private fs: FilesystemService,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
    private toastCtl: ToastController,
    private alertCtl: AlertController,
    private sheetCtl: ActionSheetController
  ) {}

  /* ================================================================ */
  /*  Lifecycle                                                        */
  /* ================================================================ */

  async ngOnInit(): Promise<void> {
    this.updateWide();
    window.addEventListener('message', this.msgListener);

    this.subs.push(this.ai.events$.subscribe(ev => this.zone.run(() => {
      if (ev.type === 'toast') { this.toast(ev.message); }
      if (ev.type === 'chat') { this.scrollChat(); }
      this.cdr.markForCheck();
      this.cdr.detectChanges();
    })));

    try {
      this.backHandle = await App.addListener('backButton', () => this.zone.run(() => this.onBack()));
    } catch { /* running in a browser */ }

    try {
      await this.fs.init();
      this.storageLabel = this.fs.storageLabel;
      this.projects = await this.fs.listProjects();
      if (!this.projects.length) {
        await this.fs.seedProject('MyProject');
        this.projects = await this.fs.listProjects();
      }
      let last = '';
      try { last = localStorage.getItem('zeno.lastProject') || ''; } catch { /* ignore */ }
      this.project = this.projects.includes(last) ? last : this.projects[0];
    } catch (e: any) {
      this.print('error', 'Storage error: ' + (e?.message ?? e));
    }

    await this.initMonaco();
    await this.openProject(this.project);
    this.loading = false;
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.msgListener);
    this.subs.forEach(s => s.unsubscribe());
    this.backHandle?.remove();
    clearTimeout(this.autoSaveTimer);
    clearTimeout(this.previewTimer);
    this.docs.forEach(d => d.model.dispose());
    this.editor?.dispose();
  }

  @HostListener('window:resize')
  updateWide(): void {
    this.isWide = window.innerWidth >= 900;
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.saveActive(true);
    }
  }

  private onBack(): void {
    if (this.settingsOpen) { this.settingsOpen = false; }
    else if (this.aiOpen) { this.aiOpen = false; }
    else if (this.sidebarOpen) { this.sidebarOpen = false; }
    else if (this.panelOpen) { this.panelOpen = false; }
    else { App.minimizeApp().catch(() => undefined); }
    this.cdr.detectChanges();
  }

  /* ================================================================ */
  /*  Monaco                                                           */
  /* ================================================================ */

  private loadMonaco(): Promise<typeof Monaco> {
    const w = window as any;
    if (w.monaco) { return Promise.resolve(w.monaco); }
    const base = new URL('assets/monaco', document.baseURI).toString().replace(/\/$/, '');
    w.MonacoEnvironment = {
      getWorkerUrl: () => {
        const code = `self.MonacoEnvironment={baseUrl:'${base}/'};importScripts('${base}/vs/base/worker/workerMain.js');`;
        return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      }
    };
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + '/vs/loader.js';
      s.onload = () => {
        const req = w.require;
        req.config({ paths: { vs: base + '/vs' } });
        req(['vs/editor/editor.main'], () => resolve(w.monaco), reject);
      };
      s.onerror = () => reject(new Error('Cannot load Monaco from ' + base));
      document.body.appendChild(s);
    });
  }

  private async initMonaco(): Promise<void> {
    this.monaco = await this.loadMonaco();
    const monaco = this.monaco;

    monaco.editor.defineTheme('zeno-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
        'editorGutter.background': '#1e1e1e',
        'minimap.background': '#1a1a1a'
      }
    });

    // IntelliSense setup for JS / TS
    const ts: any = (monaco.languages as any).typescript;
    if (ts) {
      const opts = {
        target: ts.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        lib: ['es2020', 'dom', 'dom.iterable']
      };
      ts.javascriptDefaults.setCompilerOptions(opts);
      ts.typescriptDefaults.setCompilerOptions({ ...opts, noEmit: false });
      ts.javascriptDefaults.setEagerModelSync(true);
      ts.typescriptDefaults.setEagerModelSync(true);
    }

    this.zone.runOutsideAngular(() => {
      this.editor = monaco.editor.create(this.editorHost.nativeElement, {
        model: null,
        theme: 'zeno-dark',
        automaticLayout: true,
        fontSize: 14,
        lineHeight: 21,
        tabSize: 2,
        minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        padding: { top: 8, bottom: 8 },
        quickSuggestions: { other: true, comments: false, strings: true },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'on',
        parameterHints: { enabled: true },
        formatOnPaste: true,
        bracketPairColorization: { enabled: true },
        renderWhitespace: 'selection',
        fixedOverflowWidgets: true,
        mouseWheelZoom: false
      });

      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        this.zone.run(() => this.saveActive(true));
      });
    });

    const ctx: VisionContext = {
      projectName: () => this.project,
      currentFile: () => {
        const d = this.docs.get(this.activePath);
        return d ? { name: this.fileName(this.activePath), path: this.activePath, language: d.model.getLanguageId() } : null;
      },
      openFiles: () => this.tabs.map(t => {
        const d = this.docs.get(t.path)!;
        return { name: t.name, path: t.path, language: d.model.getLanguageId(), content: d.model.getValue() };
      }),
      projectFiles: async () => (await this.fs.flatFiles(this.project)).map(f => f.rel),
      readProjectFile: rel => this.fs.readFile(this.fs.projectRoot(this.project) + '/' + rel),
      terminalOutput: () => this.termLines.slice(-60).map(l => l.text).join('\n')
    };
    this.ai.attach(this.editor, monaco, ctx);
  }

  private languageFor(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return LANG_BY_EXT[ext] ?? 'plaintext';
  }

  fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  /* ================================================================ */
  /*  Projects & tree                                                  */
  /* ================================================================ */

  async openProject(name: string): Promise<void> {
    if (!name) { return; }
    // close everything from the previous project
    this.tabs = [];
    this.docs.forEach(d => d.model.dispose());
    this.docs.clear();
    this.activePath = '';
    this.editor?.setModel(null);

    this.project = name;
    this.selectedDir = this.fs.projectRoot(name);
    try { localStorage.setItem('zeno.lastProject', name); } catch { /* ignore */ }
    this.expanded.clear();
    await this.refreshTree();

    const flat = await this.fs.flatFiles(name);
    const entry = flat.find(f => f.rel === 'index.html') ?? flat[0];
    if (entry) { await this.openFile(entry.path); }
    this.cdr.detectChanges();
  }

  async refreshTree(): Promise<void> {
    try {
      this.tree = await this.fs.tree(this.project);
    } catch {
      this.tree = [];
    }
    this.rebuildRows();
  }

  private rebuildRows(): void {
    const rows: Row[] = [];
    const walk = (nodes: FsNode[], depth: number) => {
      for (const n of nodes) {
        rows.push({ node: n, depth });
        if (n.isDir && this.expanded.has(n.path)) { walk(n.children ?? [], depth + 1); }
      }
    };
    walk(this.tree, 0);
    this.rows = rows;
  }

  trackRow(_: number, r: Row): string { return r.node.path; }
  trackTab(_: number, t: Tab): string { return t.path; }

  async onRowTap(r: Row): Promise<void> {
    if (r.node.isDir) {
      if (this.expanded.has(r.node.path)) { this.expanded.delete(r.node.path); } else { this.expanded.add(r.node.path); }
      this.selectedDir = r.node.path;
      this.rebuildRows();
    } else {
      this.selectedDir = r.node.path.slice(0, r.node.path.lastIndexOf('/'));
      await this.openFile(r.node.path);
      if (!this.isWide) { this.sidebarOpen = false; }
    }
  }

  fileIcon(name: string, isDir: boolean, open = false): string {
    if (isDir) { return open ? '📂' : '📁'; }
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'html': case 'htm': return '🌐';
      case 'css': case 'scss': return '🎨';
      case 'js': case 'mjs': return '🟨';
      case 'ts': return '🟦';
      case 'py': return '🐍';
      case 'json': return '🧾';
      case 'md': return '📝';
      default: return '📄';
    }
  }

  private validName(name: string | null): string | null {
    if (!name) { return null; }
    const n = name.trim().replace(/^\/+|\/+$/g, '');
    if (!n || n.split('/').some(p => !p || p === '.' || p === '..') || /[\\:*?"<>|]/.test(n)) {
      this.toast('Invalid name');
      return null;
    }
    return n;
  }

  async newFile(dir?: string): Promise<void> {
    const base = dir ?? this.selectedDir ?? this.fs.projectRoot(this.project);
    const name = this.validName(await this.askText('New file', '', 'name.js'));
    if (!name) { return; }
    const path = base + '/' + name;
    if (await this.fs.exists(path)) { this.toast('Already exists'); return; }
    await this.fs.writeFile(path, '');
    this.expanded.add(base);
    await this.refreshTree();
    await this.openFile(path);
  }

  async newFolder(dir?: string): Promise<void> {
    const base = dir ?? this.selectedDir ?? this.fs.projectRoot(this.project);
    const name = this.validName(await this.askText('New folder', '', 'folder'));
    if (!name) { return; }
    const path = base + '/' + name;
    if (await this.fs.exists(path)) { this.toast('Already exists'); return; }
    await this.fs.createFolder(path);
    this.expanded.add(base);
    this.expanded.add(path);
    await this.refreshTree();
  }

  async rowMenu(r: Row, ev: Event): Promise<void> {
    ev.stopPropagation();
    const n = r.node;
    const buttons: any[] = [];
    if (n.isDir) {
      buttons.push({ text: 'New file here', handler: () => { this.newFile(n.path); } });
      buttons.push({ text: 'New folder here', handler: () => { this.newFolder(n.path); } });
    } else {
      buttons.push({ text: 'Open', handler: () => { this.openFile(n.path); } });
    }
    buttons.push({ text: 'Rename', handler: () => { this.renameEntry(n); } });
    buttons.push({ text: 'Delete', role: 'destructive', handler: () => { this.deleteEntry(n); } });
    buttons.push({ text: 'Cancel', role: 'cancel' });
    const sheet = await this.sheetCtl.create({ header: n.name, buttons, cssClass: 'zeno-sheet' });
    await sheet.present();
  }

  async renameEntry(n: FsNode): Promise<void> {
    const name = this.validName(await this.askText('Rename', n.name, n.name));
    if (!name || name === n.name) { return; }
    const parent = n.path.slice(0, n.path.lastIndexOf('/'));
    const to = parent + '/' + name;
    if (await this.fs.exists(to)) { this.toast('Name already used'); return; }
    await this.saveAll();
    const wasOpen = !n.isDir && this.docs.has(n.path);
    this.closeTabsUnder(n.path);
    await this.fs.rename(n.path, to);
    if (this.expanded.delete(n.path)) { this.expanded.add(to); }
    await this.refreshTree();
    if (wasOpen) { await this.openFile(to); }
  }

  async deleteEntry(n: FsNode): Promise<void> {
    const ok = await this.confirm('Delete ' + n.name + '?', n.isDir ? 'The folder and everything in it will be removed.' : 'This cannot be undone.');
    if (!ok) { return; }
    this.closeTabsUnder(n.path);
    await this.fs.deleteEntry(n.path);
    await this.refreshTree();
    this.toast('Deleted ' + n.name);
  }

  async projectMenu(): Promise<void> {
    const buttons: any[] = this.projects.map(p => ({
      text: (p === this.project ? '✓ ' : '') + p,
      handler: () => { this.zone.run(() => { this.openProject(p); }); }
    }));
    buttons.push({ text: '＋ New project', handler: () => { this.newProject(); } });
    if (this.projects.length > 1) {
      buttons.push({ text: 'Delete this project', role: 'destructive', handler: () => { this.deleteProject(); } });
    }
    buttons.push({ text: 'Cancel', role: 'cancel' });
    const sheet = await this.sheetCtl.create({ header: 'Projects (' + this.storageLabel + ')', buttons, cssClass: 'zeno-sheet' });
    await sheet.present();
  }

  async newProject(): Promise<void> {
    const name = this.validName(await this.askText('New project', '', 'MyApp'));
    if (!name || name.includes('/')) { return; }
    if (this.projects.includes(name)) { this.toast('Project exists'); return; }
    await this.fs.seedProject(name);
    this.projects = await this.fs.listProjects();
    await this.openProject(name);
  }

  async deleteProject(): Promise<void> {
    const ok = await this.confirm('Delete project ' + this.project + '?', 'All files in it will be removed.');
    if (!ok) { return; }
    const gone = this.project;
    await this.fs.deleteEntry(this.fs.projectRoot(gone));
    this.projects = await this.fs.listProjects();
    await this.openProject(this.projects[0]);
  }

  /* ================================================================ */
  /*  Tabs / documents                                                 */
  /* ================================================================ */

  async openFile(path: string): Promise<void> {
    let doc = this.docs.get(path);
    if (!doc) {
      let content = '';
      try { content = await this.fs.readFile(path); } catch (e: any) { this.toast('Cannot open: ' + (e?.message ?? e)); return; }
      const uri = this.monaco.Uri.file('/' + path);
      const model = this.monaco.editor.getModel(uri) ?? this.monaco.editor.createModel(content, this.languageFor(path), uri);
      doc = { model, savedVersion: model.getAlternativeVersionId() };
      this.docs.set(path, doc);
      this.tabs.push({ path, name: this.fileName(path), dirty: false });
      model.onDidChangeContent(() => this.zone.run(() => this.onModelChanged(path)));
    }
    this.activate(path);
  }

  private activate(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) { return; }
    this.activePath = path;
    this.editor.setModel(doc.model);
    this.editor.focus();
    this.cdr.detectChanges();
  }

  selectTab(t: Tab): void { this.activate(t.path); }

  private onModelChanged(path: string): void {
    const doc = this.docs.get(path);
    const tab = this.tabs.find(t => t.path === path);
    if (!doc || !tab) { return; }
    tab.dirty = doc.model.getAlternativeVersionId() !== doc.savedVersion;
    if (this.autoSave && tab.dirty) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = setTimeout(() => this.zone.run(() => this.saveAll(false)), 1500);
    }
    this.schedulePreview();
    this.cdr.markForCheck();
  }

  async saveActive(manual: boolean): Promise<void> {
    if (!this.activePath) { return; }
    await this.savePath(this.activePath);
    if (manual) { this.toast('Saved ' + this.fileName(this.activePath)); }
  }

  async saveAll(announce = false): Promise<void> {
    for (const t of this.tabs) { if (t.dirty) { await this.savePath(t.path); } }
    if (announce) { this.toast('All files saved'); }
  }

  private async savePath(path: string): Promise<void> {
    const doc = this.docs.get(path);
    const tab = this.tabs.find(t => t.path === path);
    if (!doc || !tab) { return; }
    try {
      await this.fs.writeFile(path, doc.model.getValue());
      doc.savedVersion = doc.model.getAlternativeVersionId();
      tab.dirty = false;
    } catch (e: any) {
      this.toast('Save failed: ' + (e?.message ?? e));
    }
    this.cdr.markForCheck();
  }

  async closeTab(t: Tab, ev?: Event): Promise<void> {
    ev?.stopPropagation();
    if (t.dirty) { await this.savePath(t.path); }
    const idx = this.tabs.findIndex(x => x.path === t.path);
    if (idx < 0) { return; }
    this.tabs.splice(idx, 1);
    this.docs.get(t.path)?.model.dispose();
    this.docs.delete(t.path);
    if (this.activePath === t.path) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) { this.activate(next.path); } else { this.activePath = ''; this.editor.setModel(null); }
    }
    this.cdr.detectChanges();
  }

  private closeTabsUnder(path: string): void {
    const gone = this.tabs.filter(t => t.path === path || t.path.startsWith(path + '/'));
    for (const t of gone) {
      const idx = this.tabs.findIndex(x => x.path === t.path);
      this.tabs.splice(idx, 1);
      this.docs.get(t.path)?.model.dispose();
      this.docs.delete(t.path);
    }
    if (!this.docs.has(this.activePath)) {
      const next = this.tabs[this.tabs.length - 1];
      if (next) { this.activate(next.path); } else { this.activePath = ''; this.editor.setModel(null); }
    }
  }

  /** Swipe a tab upwards to close it. */
  onTabTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    this.touchStart = { x: t.clientX, y: t.clientY };
  }

  onTabTouchEnd(e: TouchEvent, tab: Tab): void {
    if (!this.touchStart) { return; }
    const t = e.changedTouches[0];
    const dy = t.clientY - this.touchStart.y;
    const dx = t.clientX - this.touchStart.x;
    this.touchStart = null;
    if (dy < -36 && Math.abs(dx) < 48) { this.closeTab(tab); }
  }

  /* ================================================================ */
  /*  Run / preview / terminal                                         */
  /* ================================================================ */

  get activeLang(): string {
    return this.docs.get(this.activePath)?.model.getLanguageId() ?? '';
  }

  async run(): Promise<void> {
    if (!this.activePath) { this.toast('Open a file first'); return; }
    await this.saveAll(false);
    const lang = this.activeLang;
    if (lang === 'html' || lang === 'css') {
      this.showPanel('preview');
      await this.reloadPreview();
    } else if (lang === 'javascript') {
      this.showPanel('terminal');
      this.runJs(this.docs.get(this.activePath)!.model.getValue(), this.fileName(this.activePath));
    } else if (lang === 'typescript') {
      this.showPanel('terminal');
      await this.runTs();
    } else if (lang === 'python') {
      this.showPanel('terminal');
      await this.runPython(this.docs.get(this.activePath)!.model.getValue(), this.fileName(this.activePath));
    } else {
      this.toast('Run supports HTML, CSS, JS, TS and Python');
    }
  }

  showPanel(tab: 'terminal' | 'preview'): void {
    this.panelOpen = true;
    this.panelTab = tab;
    this.cdr.detectChanges();
    if (tab === 'terminal') { this.scrollTerm(); }
  }

  togglePanel(): void { this.panelOpen = !this.panelOpen; }

  splitPreview(): void {
    this.showPanel('preview');
    this.panelFull = false;
    this.reloadPreview();
  }

  private schedulePreview(): void {
    if (!this.panelOpen || this.panelTab !== 'preview') { return; }
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.zone.run(() => this.reloadPreview()), 800);
  }

  private async readForPreview(path: string): Promise<string | null> {
    const d = this.docs.get(path);
    if (d) { return d.model.getValue(); }
    try { return await this.fs.readFile(path); } catch { return null; }
  }

  private resolvePath(baseDir: string, ref: string): string {
    const parts = (ref.startsWith('/') ? this.fs.projectRoot(this.project) + ref : baseDir + '/' + ref).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') { out.pop(); } else if (p && p !== '.') { out.push(p); }
    }
    return out.join('/');
  }

  private async buildPreviewHtml(): Promise<string> {
    const root = this.fs.projectRoot(this.project);
    let entry = this.activeLang === 'html' ? this.activePath : root + '/index.html';
    if (!(await this.readForPreview(entry))) {
      const flat = await this.fs.flatFiles(this.project);
      const alt = flat.find(f => f.rel.endsWith('.html'));
      if (!alt) { return '<body style="background:#0e0e10;color:#aaa;font-family:sans-serif;padding:24px">No HTML file in this project.</body>'; }
      entry = alt.path;
    }
    let html = (await this.readForPreview(entry)) ?? '';
    const baseDir = entry.slice(0, entry.lastIndexOf('/'));
    const isLocal = (u: string) => !/^([a-z]+:)?\/\//i.test(u) && !/^(data|blob|mailto|tel|#)/i.test(u);

    // inline <link rel="stylesheet" href="local.css">
    const linkRe = /<link\b[^>]*?rel=["']stylesheet["'][^>]*?>/gi;
    const links = html.match(linkRe) ?? [];
    for (const tag of links) {
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href || !isLocal(href)) { continue; }
      const css = await this.readForPreview(this.resolvePath(baseDir, href.split('?')[0]));
      if (css !== null) { html = html.replace(tag, () => '<style>\n' + css + '\n</style>'); }
    }
    // inline <script src="local.js"></script>
    const scriptRe = /<script\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?>\s*<\/script>/gi;
    const scripts: { tag: string; src: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(html))) { scripts.push({ tag: m[0], src: m[1] }); }
    for (const s of scripts) {
      if (!isLocal(s.src)) { continue; }
      const js = await this.readForPreview(this.resolvePath(baseDir, s.src.split('?')[0]));
      if (js !== null) {
        const typeAttr = /type=["']module["']/i.test(s.tag) ? ' type="module"' : '';
        html = html.replace(s.tag, () => '<script' + typeAttr + '>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>');
      }
    }
    const hook = '<script>' + CONSOLE_HOOK + '</script>';
    if (/<head[^>]*>/i.test(html)) { html = html.replace(/<head[^>]*>/i, h => h + hook); }
    else { html = hook + html; }
    return html;
  }

  async reloadPreview(): Promise<void> {
    try {
      const html = await this.buildPreviewHtml();
      this.previewFrame.nativeElement.srcdoc = html;
    } catch (e: any) {
      this.print('error', 'Preview error: ' + (e?.message ?? e));
    }
  }

  private onFrameMessage(e: MessageEvent): void {
    const d = e.data;
    if (!d || !d.zeno) { return; }
    const known = [this.previewFrame?.nativeElement.contentWindow, this.runFrame?.contentWindow, this.replFrame?.contentWindow];
    if (!known.includes(e.source as Window)) { return; }
    this.zone.run(() => this.print(d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : 'log', String(d.text)));
  }

  print(level: TermLine['level'], text: string): void {
    this.termLines.push({ level, text });
    if (this.termLines.length > 500) { this.termLines.splice(0, this.termLines.length - 500); }
    this.scrollTerm();
    this.cdr.markForCheck();
  }

  private scrollTerm(): void {
    setTimeout(() => { const el = this.termBox?.nativeElement; if (el) { el.scrollTop = el.scrollHeight; } }, 30);
  }

  clearTerm(): void { this.termLines = []; }

  private runJs(code: string, label: string): void {
    this.print('sys', '▶ node-less run: ' + label);
    this.runFrame?.remove();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.display = 'none';
    f.srcdoc = '<!doctype html><html><head><script>' + CONSOLE_HOOK + '</script></head><body><script>\n' +
      code.replace(/<\/script/gi, '<\\/script') + '\n</script></body></html>';
    document.body.appendChild(f);
    this.runFrame = f;
  }

  private async runTs(): Promise<void> {
    const doc = this.docs.get(this.activePath)!;
    this.print('sys', '▶ compiling ' + this.fileName(this.activePath));
    try {
      const ts: any = (this.monaco.languages as any).typescript;
      const getWorker = await ts.getTypeScriptWorker();
      const client = await getWorker(doc.model.uri);
      const out = await client.getEmitOutput(doc.model.uri.toString());
      const js = out.outputFiles?.find((f: any) => f.name.endsWith('.js'))?.text;
      if (!js) { this.print('error', 'TypeScript produced no output'); return; }
      this.runJs(js, this.fileName(this.activePath));
    } catch (e: any) {
      this.print('error', 'TypeScript error: ' + (e?.message ?? e));
    }
  }

  private loadPyodideRuntime(): Promise<any> {
    if (this.pyodide) { return Promise.resolve(this.pyodide); }
    if (this.pyodideLoading) { return this.pyodideLoading; }
    this.print('sys', '⏳ Loading Pyodide (first run needs internet)…');
    this.pyodideLoading = new Promise((resolve, reject) => {
      const start = () => (window as any).loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.23.4/full/'
      }).then((py: any) => {
        py.setStdout({ batched: (s: string) => this.zone.run(() => this.print('log', s)) });
        py.setStderr({ batched: (s: string) => this.zone.run(() => this.print('error', s)) });
        this.pyodide = py;
        this.print('sys', '✔ Pyodide ready');
        resolve(py);
      }).catch(reject);
      if ((window as any).loadPyodide) { start(); return; }
      const s = document.createElement('script');
      s.src = PYODIDE_URL;
      s.onload = start;
      s.onerror = () => reject(new Error('Cannot download Pyodide. Check your internet connection.'));
      document.head.appendChild(s);
    }).catch(err => { this.pyodideLoading = null; throw err; });
    return this.pyodideLoading;
  }

  private async runPython(code: string, label: string): Promise<void> {
    this.print('sys', '▶ python: ' + label);
    try {
      const py = await this.loadPyodideRuntime();
      await py.runPythonAsync(code);
    } catch (e: any) {
      this.print('error', String(e?.message ?? e));
    }
  }

  private ensureRepl(): HTMLIFrameElement {
    if (this.replFrame) { return this.replFrame; }
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.display = 'none';
    f.srcdoc = '<!doctype html><html><body><script>' + CONSOLE_HOOK + REPL_LISTENER + '</script></body></html>';
    document.body.appendChild(f);
    this.replFrame = f;
    return f;
  }

  async submitTerm(): Promise<void> {
    const line = this.termInput.trim();
    this.termInput = '';
    if (!line) { return; }
    this.termHistory.push(line);
    this.termHistIdx = -1;
    this.print('cmd', '$ ' + line);

    if (line === 'clear') { this.clearTerm(); return; }
    if (line === 'help') {
      this.print('sys', 'Commands: help, clear, ls, run, py <code>, js <code>  (anything else runs as JavaScript)');
      return;
    }
    if (line === 'ls') {
      const files = await this.fs.flatFiles(this.project);
      this.print('log', files.map(f => f.rel).join('\n') || '(empty)');
      return;
    }
    if (line === 'run') { await this.run(); return; }
    if (line.startsWith('py ')) { await this.runPython(line.slice(3), 'terminal'); return; }

    const code = line.startsWith('js ') ? line.slice(3) : line;
    const f = this.ensureRepl();
    // iframe may still be loading on the very first command
    const send = () => f.contentWindow?.postMessage({ zenoEval: code }, '*');
    if (f.contentDocument?.readyState === 'complete' || (f as any)._ready) { send(); }
    else { f.addEventListener('load', () => { (f as any)._ready = true; send(); }, { once: true }); }
  }

  termHistoryNav(dir: -1 | 1): void {
    if (!this.termHistory.length) { return; }
    this.termHistIdx = this.termHistIdx < 0 ? this.termHistory.length : this.termHistIdx;
    this.termHistIdx = Math.max(0, Math.min(this.termHistory.length, this.termHistIdx + dir));
    this.termInput = this.termHistory[this.termHistIdx] ?? '';
  }

  /* ================================================================ */
  /*  AI panel                                                         */
  /* ================================================================ */

  toggleAi(): void {
    this.aiOpen = !this.aiOpen;
    if (this.aiOpen) { this.ai.analyzeCurrent(); this.scrollChat(); }
  }

  get visionTabs(): number { return this.tabs.length; }

  get autoMode(): boolean { return this.ai.autoMode; }
  set autoMode(v: boolean) {
    this.ai.autoMode = v;
    this.toast(v ? 'Auto Debug Mode ON — Zeno is watching your code' : 'Auto Debug Mode OFF');
  }

  async sendAi(): Promise<void> {
    const text = this.aiInput.trim();
    if (!text) { return; }
    this.aiInput = '';
    await this.ai.askAI(text);
    this.cdr.detectChanges();
    this.scrollChat();
  }

  quickAsk(text: string): void {
    this.aiInput = text;
    this.sendAi();
  }

  applyFix(msg: ChatMessage): void { this.ai.applyFix(msg); }

  /** Shows only changed lines with one line of context. */
  visibleDiff(fix: AiFix): DiffLine[] {
    const cached = this.diffCache.get(fix);
    if (cached) { return cached; }
    const d = fix.diff;
    const keep = new Array(d.length).fill(false);
    d.forEach((l, i) => {
      if (l.type !== 'same') { for (let k = Math.max(0, i - 1); k <= Math.min(d.length - 1, i + 1); k++) { keep[k] = true; } }
    });
    const out: DiffLine[] = [];
    let skipped = false;
    d.forEach((l, i) => {
      if (keep[i]) { out.push(l); skipped = false; }
      else if (!skipped) { out.push({ type: 'same', text: '⋯' }); skipped = true; }
    });
    this.diffCache.set(fix, out);
    return out;
  }

  /** Text of a chat reply without the big code block (the diff shows it instead). */
  replyText(m: ChatMessage): string {
    if (!m.fix) { return m.content; }
    return m.content.replace(/```[\w+-]*\n[\s\S]*?```/, '[code → see diff below]');
  }

  toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) { this.settingsDraft = { ...this.ai.settings }; }
  }

  saveSettings(): void {
    this.ai.saveSettings({
      apiKey: this.settingsDraft.apiKey.trim(),
      endpoint: this.settingsDraft.endpoint.trim() || 'https://api.openai.com/v1/chat/completions',
      model: this.settingsDraft.model.trim() || 'gpt-4o-mini'
    });
    this.settingsOpen = false;
    this.toast('AI settings saved');
  }

  private scrollChat(): void {
    setTimeout(() => { const el = this.chatBox?.nativeElement; if (el) { el.scrollTop = el.scrollHeight; } }, 50);
  }

  /* ================================================================ */
  /*  Dialog helpers                                                   */
  /* ================================================================ */

  async toast(message: string): Promise<void> {
    const t = await this.toastCtl.create({ message, duration: 2200, position: 'top', cssClass: 'zeno-toast' });
    await t.present();
  }

  private async askText(header: string, value: string, placeholder: string): Promise<string | null> {
    const a = await this.alertCtl.create({
      header,
      inputs: [{ name: 'v', type: 'text', value, placeholder }],
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'OK', role: 'confirm' }]
    });
    await a.present();
    const r = await a.onDidDismiss();
    return r.role === 'confirm' ? String(r.data?.values?.v ?? '') : null;
  }

  private async confirm(header: string, message: string): Promise<boolean> {
    const a = await this.alertCtl.create({
      header, message,
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Delete', role: 'confirm', cssClass: 'danger' }]
    });
    await a.present();
    return (await a.onDidDismiss()).role === 'confirm';
  }
}
