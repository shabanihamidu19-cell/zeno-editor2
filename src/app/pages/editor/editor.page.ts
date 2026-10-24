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
      const model = this.monaco.editor.createModel(content, this.languageFor(path), uri);
      doc = { model, savedVersion: model.getAlternativeVersionId() };
      this.docs.set(path, doc);
      model.onDidChangeContent(() => {
        const t = this.tabs.find(x => x.path === path);
        if (t) { t.dirty = model.getAlternativeVersionId() !== doc!.savedVersion; }
        this.scheduleAutoSave();
        this.schedulePreview();
        this.cdr.markForCheck();
      });
    }
    if (!this.tabs.find(t => t.path === path)) {
      this.tabs.push({ path, name: this.fileName(path), dirty: false });
    }
    this.activePath = path;
    this.editor.setModel(doc.model);
    this.cdr.detectChanges();
  }

  selectTab(t: Tab): void {
    this.activePath = t.path;
    const doc = this.docs.get(t.path);
    if (doc) { this.editor.setModel(doc.model); }
    this.cdr.detectChanges();
  }

  closeTab(t: Tab, ev?: Event): void {
    ev?.stopPropagation();
    const idx = this.tabs.indexOf(t);
    if (idx < 0) { return; }
    this.tabs.splice(idx, 1);
    const doc = this.docs.get(t.path);
    if (doc) { doc.model.dispose(); this.docs.delete(t.path); }
    if (this.activePath === t.path) {
      const next = this.tabs[idx] || this.tabs[idx - 1];
      if (next) { this.selectTab(next); }
      else { this.activePath = ''; this.editor.setModel(null); }
    }
    this.cdr.detectChanges();
  }

  private closeTabsUnder(path: string): void {
    const toClose = this.tabs.filter(t => t.path === path || t.path.startsWith(path + '/'));
    toClose.forEach(t => this.closeTab(t));
  }

  private scheduleAutoSave(): void {
    if (!this.autoSave) { return; }
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => this.zone.run(() => this.saveActive(false)), 1200);
  }

  async saveActive(showToast = false): Promise<void> {
    const path = this.activePath;
    const doc = this.docs.get(path);
    if (!doc) { return; }
    try {
      await this.fs.writeFile(path, doc.model.getValue());
      doc.savedVersion = doc.model.getAlternativeVersionId();
      const t = this.tabs.find(x => x.path === path);
      if (t) { t.dirty = false; }
      if (showToast) { this.toast('Saved'); }
    } catch (e: any) {
      this.toast('Save failed: ' + (e?.message ?? e));
    }
    this.cdr.detectChanges();
  }

  async saveAll(): Promise<void> {
    for (const t of this.tabs) {
      if (t.dirty) {
        const doc = this.docs.get(t.path);
        if (doc) {
          await this.fs.writeFile(t.path, doc.model.getValue());
          doc.savedVersion = doc.model.getAlternativeVersionId();
          t.dirty = false;
        }
      }
    }
  }

  onTabTouchStart(e: TouchEvent): void {
    this.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }

  onTabTouchEnd(e: TouchEvent, t: Tab): void {
    if (!this.touchStart) { return; }
    const dx = e.changedTouches[0].clientX - this.touchStart.x;
    const dy = e.changedTouches[0].clientY - this.touchStart.y;
    this.touchStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) { this.closeTab(t); }
  }

  /* ================================================================ */
  /*  Panel / Terminal / Preview                                       */
  /* ================================================================ */

  showPanel(tab: 'terminal' | 'preview'): void {
    this.panelOpen = true;
    this.panelTab = tab;
    this.cdr.detectChanges();
    if (tab === 'terminal') { this.scrollTerm(); }
  }

  togglePanel(): void { this.panelOpen = !this.panelOpen; }

  onPreviewTabClick(): void {
    if (this.panelOpen && this.panelTab === 'preview') {
      this.togglePanel();
    } else {
      this.showPanel('preview');
      this.reloadPreview();
    }
  }

  onTerminalTabClick(): void {
    if (this.panelOpen && this.panelTab === 'terminal') {
      this.togglePanel();
    } else {
      this.showPanel('terminal');
    }
  }

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
    // Simplified for length - the full method is in the local file
    return '<html><body>Preview</body></html>';
  }

  async reloadPreview(): Promise<void> {
    // Full implementation in local fixed file
  }

  clearTerm(): void {
    this.termLines = [];
    this.cdr.detectChanges();
  }

  private scrollTerm(): void {
    setTimeout(() => {
      const el = this.termBox?.nativeElement;
      if (el) { el.scrollTop = el.scrollHeight; }
    }, 30);
  }

  print(level: TermLine['level'], text: string): void {
    this.termLines.push({ level, text });
    if (this.termLines.length > 500) { this.termLines = this.termLines.slice(-400); }
    this.scrollTerm();
    this.cdr.detectChanges();
  }

  submitTerm(): void {
    const cmd = this.termInput.trim();
    if (!cmd) { return; }
    this.termInput = '';
    this.termHistory.unshift(cmd);
    this.termHistIdx = -1;
    this.print('cmd', '$ ' + cmd);
    // Full terminal logic in local file
  }

  termHistoryNav(dir: number): void {
    // Full implementation in local file
  }

  /* ================================================================ */
  /*  Run                                                              */
  /* ================================================================ */

  async run(): Promise<void> {
    // Full implementation in local file
  }

  /* ================================================================ */
  /*  AI                                                               */
  /* ================================================================ */

  get visionTabs(): number { return this.tabs.length; }

  get autoMode(): boolean { return this.ai.autoMode; }
  set autoMode(v: boolean) { this.ai.autoMode = v; }

  toggleAi(): void {
    this.aiOpen = !this.aiOpen;
    if (this.aiOpen) { this.scrollChat(); }
    this.cdr.detectChanges();
  }

  quickAsk(q: string): void {
    this.aiInput = q;
    this.sendAi();
  }

  sendAi(): void {
    // Full implementation in local file
  }

  applyFix(m: ChatMessage): void {
    // Full implementation in local file
  }

  visibleDiff(fix: AiFix): DiffLine[] {
    // Full implementation in local file
    return [];
  }

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
