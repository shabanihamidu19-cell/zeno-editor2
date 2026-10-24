import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import type * as Monaco from 'monaco-editor';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface OpenFileSnapshot {
  name: string;
  path: string;
  language: string;
  content: string;
}

/** The editor page implements this so the AI can "see" the whole environment. */
export interface VisionContext {
  projectName(): string;
  currentFile(): { name: string; path: string; language: string } | null;
  openFiles(): OpenFileSnapshot[];
  projectFiles(): Promise<string[]>;
  readProjectFile(rel: string): Promise<string>;
  terminalOutput(): string;
}

export interface Edit { offset: number; length: number; text: string; }

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  offset: number;
  length: number;
  fixLabel?: string;
  fixes?: Edit[];
}

export interface DiffLine { type: 'same' | 'add' | 'del'; text: string; }

export interface AiFix { code: string; diff: DiffLine[]; }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system-note';
  content: string;
  fix?: AiFix;
  applied?: boolean;
}

export interface AiSettings { apiKey: string; endpoint: string; model: string; }

export interface VisionPayload {
  context: string;
  currentFile: string;
  currentCode: string;
  errorMarkers: { severity: string; message: string; line: number; column: number; source: string }[];
  terminalOutput: string;
  userGoal: string;
  openTabs?: { name: string; content: string }[];
}

export type AiEvent =
  | { type: 'toast'; message: string }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'busy'; busy: boolean }
  | { type: 'issues'; count: number };

export const ZENO_SYSTEM_PROMPT =
  'You are Zeno, a senior full-stack dev living inside a mobile code editor. You can see the user\'s entire code. ' +
  'Fix errors, suggest improvements, auto-complete. Be concise. Always return fixed code block.';

const SETTINGS_KEY = 'zeno.ai.settings';
const AUTO_KEY = 'zeno.ai.auto';
const DEBOUNCE_MS = 1500;
const MIN_ONLINE_INTERVAL_MS = 8000;

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Tags whose end tag is optional or structural: we never flag them. */
const LENIENT_TAGS = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot',
  'colgroup', 'option', 'optgroup', 'rt', 'rp']);

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

@Injectable({ providedIn: 'root' })
export class AiVisionService {
  readonly events$ = new Subject<AiEvent>();
  readonly chat: ChatMessage[] = [];

  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private ctx: VisionContext | null = null;
  private timer: any = null;
  private applyingFix = false;
  private lastOnlineAt = 0;
  private lastOnlineSignature = '';
  private lastTyped = '';
  private _auto = false;
  busy = false;

  settings: AiSettings = { apiKey: '', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' };

  constructor() {
    try {
      const s = localStorage.getItem(SETTINGS_KEY);
      if (s) { this.settings = { ...this.settings, ...JSON.parse(s) }; }
      this._auto = localStorage.getItem(AUTO_KEY) === '1';
    } catch { /* storage unavailable */ }
  }

  /* ---------------- configuration ---------------- */

  get autoMode(): boolean { return this._auto; }
  set autoMode(v: boolean) {
    this._auto = v;
    try { localStorage.setItem(AUTO_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    if (v) { this.schedule(); }
  }

  saveSettings(s: AiSettings): void {
    this.settings = { ...s };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
  }

  get hasApiKey(): boolean { return !!this.settings.apiKey.trim(); }

  /** Called by the editor page once Monaco exists. */
  attach(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco, ctx: VisionContext): void {
    this.editor = editor;
    this.monaco = monaco;
    this.ctx = ctx;
    editor.onDidChangeModelContent((e) => {
      if (this.applyingFix) { return; }
      const ch = e.changes[0];
      if (ch && ch.text && ch.text.trim()) { this.lastTyped = ch.text; }
      this.schedule();
    });
    editor.onDidChangeModel(() => this.schedule());
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runAuto(), DEBOUNCE_MS);
  }

  /* ---------------- vision ---------------- */

  /** SCREEN VISION: content of every open tab. */
  getAllOpenFilesContent(): OpenFileSnapshot[] {
    return this.ctx ? this.ctx.openFiles() : [];
  }

  getMarkers(): VisionPayload['errorMarkers'] {
    if (!this.editor || !this.monaco) { return []; }
    const model = this.editor.getModel();
    if (!model) { return []; }
    return this.monaco.editor.getModelMarkers({ resource: model.uri })
      .filter(m => m.severity >= this.monaco!.MarkerSeverity.Warning)
      .map(m => ({
        severity: m.severity >= this.monaco!.MarkerSeverity.Error ? 'error' : 'warning',
        message: m.message,
        line: m.startLineNumber,
        column: m.startColumn,
        source: String(m.owner)
      }));
  }

  private currentGoal(): string {
    if (!this.editor) { return ''; }
    const model = this.editor.getModel();
    const pos = this.editor.getPosition();
    if (!model || !pos) { return this.lastTyped; }
    const from = Math.max(1, pos.lineNumber - 2);
    const lines: string[] = [];
    for (let i = from; i <= pos.lineNumber; i++) { lines.push(model.getLineContent(i)); }
    return lines.join('\n').trim() || this.lastTyped;
  }

  async buildPayload(userGoal?: string): Promise<VisionPayload> {
    const cur = this.ctx?.currentFile() ?? null;
    const files = this.ctx ? await this.ctx.projectFiles() : [];
    const model = this.editor?.getModel();
    return {
      context: 'Project "' + (this.ctx?.projectName() ?? '') + '" files:\n' + files.join('\n'),
      currentFile: cur?.name ?? '',
      currentCode: model ? model.getValue() : '',
      errorMarkers: this.getMarkers(),
      terminalOutput: this.ctx?.terminalOutput() ?? '',
      userGoal: userGoal ?? this.currentGoal(),
      openTabs: this.getAllOpenFilesContent().map(f => ({ name: f.name, content: f.content }))
    };
  }

  /* ---------------- LAYER 1: offline ---------------- */

  /** Runs the offline linters on the current model and publishes markers. */
  analyzeCurrent(): Issue[] {
    if (!this.editor || !this.monaco) { return []; }
    const model = this.editor.getModel();
    if (!model) { return []; }
    const issues = analyzeText(model.getValue(), model.getLanguageId());
    const monaco = this.monaco;
    monaco.editor.setModelMarkers(model, 'zeno-ai', issues.map(i => {
      const a = model.getPositionAt(i.offset);
      const b = model.getPositionAt(i.offset + Math.max(1, i.length));
      return {
        severity: i.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: '[Zeno] ' + i.message,
        startLineNumber: a.lineNumber, startColumn: a.column,
        endLineNumber: b.lineNumber, endColumn: b.column
      };
    }));
    this.events$.next({ type: 'issues', count: issues.length });
    return issues;
  }

  /** Applies every fixable offline issue with executeEdits. Returns the toast label or ''. */
  applyOfflineFixes(issues: Issue[]): string {
    if (!this.editor) { return ''; }
    const model = this.editor.getModel();
    if (!model) { return ''; }
    const fixable = issues.filter(i => i.fixes && i.fixes.length);
    if (!fixable.length) { return ''; }

    const original = model.getValue();
    const edits = fixable.flatMap(i => i.fixes!);
    const fixed = applyEdits(original, edits);
    if (fixed === original) { return ''; }

    this.replaceMinimal(original, fixed);
    const labels = Array.from(new Set(fixable.map(i => i.fixLabel).filter(Boolean)));
    return 'AI Auto-Fixed: ' + labels.join(', ');
  }

  /** Replaces only the changed middle part so the cursor and scroll stay put. */
  private replaceMinimal(original: string, fixed: string): void {
    const editor = this.editor!;
    const model = editor.getModel()!;
    let start = 0;
    while (start < original.length && start < fixed.length && original[start] === fixed[start]) { start++; }
    let endO = original.length;
    let endF = fixed.length;
    while (endO > start && endF > start && original[endO - 1] === fixed[endF - 1]) { endO--; endF--; }
    const a = model.getPositionAt(start);
    const b = model.getPositionAt(endO);
    this.applyingFix = true;
    try {
      editor.pushUndoStop();
      editor.executeEdits('zeno-ai', [{
        range: new this.monaco!.Range(a.lineNumber, a.column, b.lineNumber, b.column),
        text: fixed.slice(start, endF),
        forceMoveMarkers: false
      }]);
      editor.pushUndoStop();
    } finally {
      // let Monaco flush its content-change event before re-enabling
      setTimeout(() => { this.applyingFix = false; }, 0);
    }
  }

  /* ---------------- auto debug loop ---------------- */

  private async runAuto(): Promise<void> {
    if (!this.editor) { return; }
    const issues = this.analyzeCurrent();

    if (this._auto) {
      const label = this.applyOfflineFixes(issues);
      if (label) {
        this.events$.next({ type: 'toast', message: label });
        // re-lint after the fix so stale markers disappear
        setTimeout(() => this.analyzeCurrent(), 50);
      }
    }

    // LAYER 2: only when there are still problems (or markers from Monaco's own workers) after layer 1
    if (this._auto && this.hasApiKey) {
      const remaining = this.getMarkers().filter(m => m.severity === 'error');
      if (remaining.length) {
        const sig = remaining.map(m => m.line + ':' + m.message).join('|');
        const now = Date.now();
        if (sig !== this.lastOnlineSignature && now - this.lastOnlineAt > MIN_ONLINE_INTERVAL_MS) {
          this.lastOnlineSignature = sig;
          this.lastOnlineAt = now;
          await this.askAI('Auto Debug: fix the errors in the current file.', true);
        }
      }
    }
  }

  /** Manual trigger: runs layer 1 and tells the user the result. */
  fixOfflineNow(): void {
    const issues = this.analyzeCurrent();
    const label = this.applyOfflineFixes(issues);
    if (label) {
      this.events$.next({ type: 'toast', message: label });
      setTimeout(() => this.analyzeCurrent(), 50);
    } else if (issues.length) {
      this.events$.next({ type: 'toast', message: 'AI found ' + issues.length + ' issue(s) it cannot auto-fix. Ask Zeno online.' });
    } else {
      this.events$.next({ type: 'toast', message: 'AI: no problems found offline.' });
    }
  }

  /* ---------------- LAYER 2: online ---------------- */

  async askAI(userText: string, automatic = false): Promise<void> {
    if (!this.hasApiKey) {
      this.pushChat({
        role: 'system-note',
        content: 'Add your API key in AI Settings (gear icon) to use the online brain. Offline auto-fix still works.'
      });
      return;
    }
    if (!automatic) { this.pushChat({ role: 'user', content: userText }); }

    this.busy = true;
    this.events$.next({ type: 'busy', busy: true });
    try {
      const payload = await this.buildPayload(userText);
      const history = this.chat
        .filter(m => m.role !== 'system-note')
        .slice(-8)
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      // the last user message is replaced by the full vision payload
      const messages = [
        { role: 'system', content: ZENO_SYSTEM_PROMPT },
        ...history.slice(0, automatic ? history.length : -1),
        { role: 'user', content: 'Vision payload (JSON):\n' + JSON.stringify(payload, null, 2) + '\n\nRequest: ' + userText }
      ];

      const res = await fetch(this.settings.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.settings.apiKey.trim() },
        body: JSON.stringify({ model: this.settings.model, messages, temperature: 0.2 })
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 200));
      }
      const data = await res.json();
      const text: string = data?.choices?.[0]?.message?.content ?? '';
      const code = extractCodeBlock(text);
      const current = payload.currentCode;
      const fix: AiFix | undefined = code && code.trim() !== current.trim()
        ? { code, diff: lineDiff(current, code) }
        : undefined;
      this.pushChat({ role: 'assistant', content: text, fix });
    } catch (e: any) {
      this.pushChat({
        role: 'system-note',
        content: 'AI request failed: ' + (e?.message ?? e) + '. Check your internet, endpoint and API key.'
      });
    } finally {
      this.busy = false;
      this.events$.next({ type: 'busy', busy: false });
    }
  }

  /** "Apply Fix" button. */
  applyFix(msg: ChatMessage): void {
    if (!this.editor || !msg.fix) { return; }
    const model = this.editor.getModel();
    if (!model) { return; }
    this.replaceMinimal(model.getValue(), msg.fix.code);
    msg.applied = true;
    this.events$.next({ type: 'toast', message: 'AI fix applied (Undo with Ctrl+Z)' });
    setTimeout(() => this.analyzeCurrent(), 50);
  }

  clearChat(): void { this.chat.length = 0; }

  private pushChat(m: ChatMessage): void {
    this.chat.push(m);
    this.events$.next({ type: 'chat', message: m });
  }
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (also used by tests)                                  */
/* ------------------------------------------------------------------ */

export function applyEdits(text: string, edits: Edit[]): string {
  // apply from the end so earlier offsets stay valid; stable for equal offsets (first listed is applied first)
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => (b.e.offset - a.e.offset) || (a.i - b.i));
  let out = text;
  for (const { e } of sorted) {
    out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length);
  }
  return out;
}

export function extractCodeBlock(text: string): string | null {
  const m = /```[\w+-]*\n([\s\S]*?)```/.exec(text);
  return m ? m[1].replace(/\n$/, '') : null;
}

/** Plain LCS line diff, good enough for single files on a phone. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length * B.length > 4_000_000) {
    return [...A.map(t => ({ type: 'del' as const, text: t })), ...B.map(t => ({ type: 'add' as const, text: t }))];
  }
  const dp: Uint32Array[] = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i++] }); }
    else { out.push({ type: 'add', text: B[j++] }); }
  }
  while (i < A.length) { out.push({ type: 'del', text: A[i++] }); }
  while (j < B.length) { out.push({ type: 'add', text: B[j++] }); }
  return out;
}

export function analyzeText(text: string, lang: string): Issue[] {
  switch (lang) {
    case 'javascript':
    case 'typescript': return [...bracketIssues(text, lang), ...semicolonIssues(text)];
    case 'python': return [...bracketIssues(text, lang), ...pythonColonIssues(text)];
    case 'css':
    case 'scss':
    case 'less': return bracketIssues(text, lang);
    case 'json': return jsonIssues(text);
    case 'html': return htmlIssues(text);
    default: return [];
  }
}

/* ---------- bracket scanner ---------- */

interface Opener { ch: string; offset: number; }
interface Mismatch { offset: number; found: string; }

const PAIRS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const CLOSERS: Record<string, string> = { '}': '{', ')': '(', ']': '[' };

/** Scans text, ignoring strings, comments and (for JS/TS) regex literals. */
export function scanBrackets(text: string, lang: string): { unclosed: Opener[]; mismatches: Mismatch[]; depthAtLineEnd: number[] } {
  const stack: Opener[] = [];
  const mismatches: Mismatch[] = [];
  const depthAtLineEnd: number[] = [];
  const isPy = lang === 'python';
  const isJs = lang === 'javascript' || lang === 'typescript';
  const isCssLike = lang === 'css' || lang === 'scss' || lang === 'less';
  const n = text.length;
  let i = 0;
  let lastSig = '';

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];

    if (c === '\n') { depthAtLineEnd.push(stack.length); i++; continue; }

    // comments
    if (isPy && c === '#') { while (i < n && text[i] !== '\n') { i++; } continue; }
    if ((isJs || isCssLike) && c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) { if (text[k] === '\n') { depthAtLineEnd.push(stack.length); } }
      i = stop; continue;
    }
    if (isJs && c === '/' && d === '/') { while (i < n && text[i] !== '\n') { i++; } continue; }
    if (lang === 'scss' && c === '/' && d === '/') { while (i < n && text[i] !== '\n') { i++; } continue; }

    // python triple quotes
    if (isPy && (c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
      const q = c.repeat(3);
      const end = text.indexOf(q, i + 3);
      const stop = end < 0 ? n : end + 3;
      for (let k = i; k < stop; k++) { if (text[k] === '\n') { depthAtLineEnd.push(stack.length); } }
      i = stop; lastSig = '"'; continue;
    }

    // strings
    if (c === '"' || c === "'" || (isJs && c === '`')) {
      const q = c;
      i++;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === q) { i++; break; }
        if (text[i] === '\n') {
          if (q === '`') { depthAtLineEnd.push(stack.length); i++; continue; }
          break; // unterminated normal string ends at line end
        }
        i++;
      }
      lastSig = '"';
      continue;
    }

    // regex literal heuristic (JS/TS)
    if (isJs && c === '/' && d !== '/' && d !== '*' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig))) {
      let k = i + 1;
      let inClass = false;
      let ok = false;
      while (k < n && text[k] !== '\n') {
        if (text[k] === '\\') { k += 2; continue; }
        if (text[k] === '[') { inClass = true; }
        else if (text[k] === ']') { inClass = false; }
        else if (text[k] === '/' && !inClass) { ok = true; break; }
        k++;
      }
      if (ok) { i = k + 1; lastSig = '"'; continue; }
    }

    if (PAIRS[c]) { stack.push({ ch: c, offset: i }); }
    else if (CLOSERS[c]) {
      const top = stack[stack.length - 1];
      if (top && top.ch === CLOSERS[c]) { stack.pop(); }
      else { mismatches.push({ offset: i, found: c }); }
    }
    if (!/\s/.test(c)) { lastSig = c; }
    i++;
  }
  depthAtLineEnd.push(stack.length);
  return { unclosed: stack, mismatches, depthAtLineEnd };
}

function bracketIssues(text: string, lang: string): Issue[] {
  const r = scanBrackets(text, lang);
  const issues: Issue[] = [];
  for (const m of r.mismatches) {
    issues.push({ severity: 'error', message: "Unexpected '" + m.found + "'", offset: m.offset, length: 1 });
  }
  if (r.unclosed.length && !r.mismatches.length) {
    const closers = r.unclosed.slice().reverse().map(o => PAIRS[o.ch]);
    let tail = closers.map(ch => (ch === '}' ? '\n}' : ch)).join('');
    if (text.endsWith('\n')) {
      // file already ends with a newline: don't create a blank line before the closers
      tail = (tail.startsWith('\n') ? tail.slice(1) : tail) + '\n';
    }
    const label = 'Added missing ' + Array.from(new Set(closers)).join(' ');
    r.unclosed.forEach((o, idx) => {
      issues.push({
        severity: 'error',
        message: "Unclosed '" + o.ch + "' (missing '" + PAIRS[o.ch] + "')",
        offset: o.offset,
        length: 1,
        // attach the single fix to the first unclosed opener only
        fixLabel: idx === 0 ? label : undefined,
        fixes: idx === 0 ? [{ offset: text.length, length: 0, text: tail }] : undefined
      });
    });
  } else if (r.unclosed.length) {
    for (const o of r.unclosed) {
      issues.push({ severity: 'error', message: "Unclosed '" + o.ch + "'", offset: o.offset, length: 1 });
    }
  }
  return issues;
}

/* ---------- JS/TS semicolons ---------- */

function semicolonIssues(text: string): Issue[] {
  const issues: Issue[] = [];
  const lines = text.split('\n');
  const scan = scanBrackets(text, 'javascript');
  let offset = 0;
  const starts: number[] = [];
  for (const l of lines) { starts.push(offset); offset += l.length + 1; }

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.replace(/\s+$/, '');
    if (!/^\s*(const|let|var)\s+[\w$]+\s*(:[^=]+)?=/.test(line)) { continue; }
    const depthBefore = idx === 0 ? 0 : scan.depthAtLineEnd[idx - 1];
    const depthAfter = scan.depthAtLineEnd[idx];
    if (depthBefore !== 0 || depthAfter !== 0) { continue; }
    if (/[;,{(\[=>+\-*/%&|?:.`]$/.test(line)) { continue; }
    if (/\/\/|\/\*/.test(line)) { continue; } // trailing comments: too risky
    // find next non-empty line
    let next = '';
    for (let k = idx + 1; k < lines.length; k++) { if (lines[k].trim()) { next = lines[k].trim(); break; } }
    if (next && /^[.(\[`+\-*/%&|?:,]/.test(next)) { continue; }
    const at = starts[idx] + line.length;
    issues.push({
      severity: 'warning',
      message: 'Missing semicolon',
      offset: Math.max(0, at - 1),
      length: 1,
      fixLabel: 'Added missing ;',
      fixes: [{ offset: at, length: 0, text: ';' }]
    });
  }
  return issues;
}

/* ---------- Python colons ---------- */

function pythonColonIssues(text: string): Issue[] {
  const issues: Issue[] = [];
  const lines = text.split('\n');
  const scan = scanBrackets(text, 'python');
  let offset = 0;
  const starts: number[] = [];
  for (const l of lines) { starts.push(offset); offset += l.length + 1; }

  // lines that are inside triple-quoted strings must be skipped: detect by re-scanning quickly
  const inString = pythonStringLines(text);

  for (let idx = 0; idx < lines.length; idx++) {
    if (inString[idx]) { continue; }
    const depthBefore = idx === 0 ? 0 : scan.depthAtLineEnd[idx - 1];
    const depthAfter = scan.depthAtLineEnd[idx];
    if (depthBefore !== 0 || depthAfter !== 0) { continue; }

    const code = stripPyComment(lines[idx]).replace(/\s+$/, '');
    if (!code.trim() || code.endsWith('\\')) { continue; }

    const kw = /^\s*(def|class|if|elif|else|for|while|try|except|finally|with|async\s+def|async\s+for|async\s+with)\b/.exec(code);
    if (!kw) { continue; }
    if (hasTopLevelColon(code)) { continue; }
    const at = starts[idx] + code.length;
    issues.push({
      severity: 'error',
      message: "Expected ':' after '" + kw[1].replace(/\s+/g, ' ') + "'",
      offset: Math.max(0, at - 1),
      length: 1,
      fixLabel: "Added missing :",
      fixes: [{ offset: at, length: 0, text: ':' }]
    });
  }
  return issues;
}

function stripPyComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') { i++; } else if (c === q) { q = ''; } continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') { return line.slice(0, i); }
  }
  return line;
}

function hasTopLevelColon(code: string): boolean {
  let depth = 0;
  let q = '';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (q) { if (c === '\\') { i++; } else if (c === q) { q = ''; } continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) { depth++; }
    else if (')]}'.includes(c)) { depth--; }
    else if (c === ':' && depth === 0) { return true; }
  }
  return false;
}

/** Marks which lines are wholly inside a triple-quoted string (docstrings). */
function pythonStringLines(text: string): boolean[] {
  const res: boolean[] = [];
  const lines = text.split('\n');
  let open: string | null = null;
  for (const line of lines) {
    const startedInside = open !== null;
    let i = 0;
    while (i < line.length) {
      if (open) {
        const end = line.indexOf(open, i);
        if (end < 0) { i = line.length; } else { i = end + 3; open = null; }
      } else {
        const m = /("""|''')/.exec(line.slice(i));
        if (!m) { break; }
        i += m.index + 3;
        open = m[1];
      }
    }
    res.push(startedInside);
  }
  return res;
}

/* ---------- JSON ---------- */

function jsonIssues(text: string): Issue[] {
  if (!text.trim()) { return []; }
  try { JSON.parse(text); return []; } catch (e: any) {
    const msg = String(e?.message ?? 'Invalid JSON');
    const pm = /position (\d+)/.exec(msg);
    const pos = pm ? Math.min(parseInt(pm[1], 10), Math.max(0, text.length - 1)) : 0;

    // attempt automatic repair: trailing commas + missing closers
    let repaired = text.replace(/,(\s*[}\]])/g, '$1');
    const sc = scanBrackets(repaired, 'json');
    if (!sc.mismatches.length && sc.unclosed.length) {
      const closers = sc.unclosed.slice().reverse().map(o => PAIRS[o.ch]);
      repaired = repaired.replace(/,\s*$/, '') + '\n' + closers.join('');
    }
    let fixable = false;
    try { JSON.parse(repaired); fixable = repaired !== text; } catch { fixable = false; }
    return [{
      severity: 'error',
      message: 'Invalid JSON: ' + msg.replace(/^JSON\.parse: /, ''),
      offset: pos,
      length: 1,
      fixLabel: fixable ? 'Repaired JSON' : undefined,
      fixes: fixable ? [{ offset: 0, length: text.length, text: repaired }] : undefined
    }];
  }
}

/* ---------- HTML ---------- */

function htmlIssues(text: string): Issue[] {
  const issues: Issue[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack: { tag: string; offset: number; len: number }[] = [];
  const inserts: Edit[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m[0].startsWith('<!--')) { continue; }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosed = /\/\s*$/.test(m[3] || '');

    if (!closing) {
      if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title') {
        // skip raw-text content up to its closing tag
        if (!selfClosed) {
          const close = new RegExp('</' + tag + '\\s*>', 'i');
          const rest = text.slice(re.lastIndex);
          const cm = close.exec(rest);
          if (!cm) {
            issues.push({
              severity: 'error', message: 'Unclosed <' + tag + '>', offset: m.index, length: m[0].length,
              fixLabel: 'Added missing </' + tag + '>', fixes: [{ offset: text.length, length: 0, text: '\n</' + tag + '>' }]
            });
            break;
          }
          re.lastIndex += cm.index; // continue at the closing tag so it is consumed normally
        }
        if (!selfClosed) { stack.push({ tag, offset: m.index, len: m[0].length }); }
        continue;
      }
      if (VOID_TAGS.has(tag) || selfClosed || LENIENT_TAGS.has(tag)) { continue; }
      stack.push({ tag, offset: m.index, len: m[0].length });
    } else {
      if (LENIENT_TAGS.has(tag) || VOID_TAGS.has(tag)) { continue; }
      const at = lastIndexOfTag(stack, tag);
      if (at < 0) {
        issues.push({ severity: 'warning', message: 'Unexpected </' + tag + '>', offset: m.index, length: m[0].length });
        continue;
      }
      // everything above `at` was never closed: insert closers right before this closing tag
      const skipped = stack.splice(at + 1).reverse();
      stack.pop(); // the matched one
      if (skipped.length) {
        const ins = skipped.map(s => '</' + s.tag + '>').join('');
        for (const s of skipped) {
          issues.push({
            severity: 'error', message: 'Unclosed <' + s.tag + '>', offset: s.offset, length: s.len,
            fixLabel: 'Added missing </' + s.tag + '>', fixes: undefined
          });
        }
        issues[issues.length - skipped.length].fixes = [{ offset: m.index, length: 0, text: ins }];
        issues[issues.length - skipped.length].fixLabel = 'Added missing ' + skipped.map(s => '</' + s.tag + '>').join('');
      }
    }
  }

  if (stack.length) {
    const lower = text.toLowerCase();
    let at = lower.lastIndexOf('</body>');
    if (at < 0) { at = lower.lastIndexOf('</html>'); }
    if (at < 0) { at = text.length; }
    const left = stack.slice().reverse();
    const ins = left.map(s => '</' + s.tag + '>').join('\n') + '\n';
    left.forEach((s, idx) => {
      issues.push({
        severity: 'error', message: 'Unclosed <' + s.tag + '>', offset: s.offset, length: s.len,
        fixLabel: idx === 0 ? 'Added missing ' + left.map(l => '</' + l.tag + '>').join('') : undefined,
        fixes: idx === 0 ? [{ offset: at, length: 0, text: ins }] : undefined
      });
    });
  }
  void inserts;
  return issues;
}

function lastIndexOfTag(stack: { tag: string }[], tag: string): number {
  for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].tag === tag) { return i; } }
  return -1;
}
