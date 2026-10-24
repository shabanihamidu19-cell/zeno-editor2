import { Injectable } from '@angular/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

export interface FsNode {
  name: string;
  /** Full path relative to the base directory (Documents or app Data), e.g. ZenoProjects/MyProject/index.html */
  path: string;
  isDir: boolean;
  children?: FsNode[];
}

export interface FlatFile {
  path: string; // full path
  rel: string;  // path relative to the project root
}

export const ROOT = 'ZenoProjects';

@Injectable({ providedIn: 'root' })
export class FilesystemService {
  private dir: Directory = Directory.Documents;

  /** Prepare storage: tries Documents/ZenoProjects, falls back to the app's private Data directory. */
  async init(): Promise<void> {
    try {
      await Filesystem.requestPermissions().catch(() => undefined);
      await this.ensureDir(ROOT);
      // probe write access
      await Filesystem.writeFile({
        path: `${ROOT}/.zeno`, data: 'zeno', directory: this.dir, encoding: Encoding.UTF8, recursive: true
      });
    } catch {
      this.dir = Directory.Data;
      await this.ensureDir(ROOT);
    }
  }

  get storageLabel(): string {
    return this.dir === Directory.Documents ? 'Documents/' + ROOT : 'App Data/' + ROOT;
  }

  projectRoot(project: string): string {
    return `${ROOT}/${project}`;
  }

  private async ensureDir(path: string): Promise<void> {
    try {
      await Filesystem.mkdir({ path, directory: this.dir, recursive: true });
    } catch (e: any) {
      if (!/exist/i.test(String(e?.message ?? e))) { throw e; }
    }
  }

  async listProjects(): Promise<string[]> {
    const res = await Filesystem.readdir({ path: ROOT, directory: this.dir });
    return res.files
      .filter(f => f.type === 'directory' && !f.name.startsWith('.'))
      .map(f => f.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async createProject(name: string): Promise<void> {
    await this.ensureDir(this.projectRoot(name));
  }

  async tree(project: string): Promise<FsNode[]> {
    return this.readTree(this.projectRoot(project));
  }

  private async readTree(path: string): Promise<FsNode[]> {
    const res = await Filesystem.readdir({ path, directory: this.dir });
    const nodes: FsNode[] = [];
    for (const f of res.files) {
      if (f.name.startsWith('.')) { continue; }
      const full = `${path}/${f.name}`;
      if (f.type === 'directory') {
        nodes.push({ name: f.name, path: full, isDir: true, children: await this.readTree(full) });
      } else {
        nodes.push({ name: f.name, path: full, isDir: false });
      }
    }
    nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return nodes;
  }

  async flatFiles(project: string): Promise<FlatFile[]> {
    const root = this.projectRoot(project);
    const out: FlatFile[] = [];
    const walk = (nodes: FsNode[]) => {
      for (const n of nodes) {
        if (n.isDir) { walk(n.children ?? []); } else { out.push({ path: n.path, rel: n.path.slice(root.length + 1) }); }
      }
    };
    walk(await this.tree(project));
    return out;
  }

  async readFile(path: string): Promise<string> {
    const r = await Filesystem.readFile({ path, directory: this.dir, encoding: Encoding.UTF8 });
    return typeof r.data === 'string' ? r.data : await (r.data as Blob).text();
  }

  async writeFile(path: string, data: string): Promise<void> {
    await Filesystem.writeFile({ path, data, directory: this.dir, encoding: Encoding.UTF8, recursive: true });
  }

  async createFolder(path: string): Promise<void> {
    await this.ensureDir(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path, directory: this.dir });
      return true;
    } catch {
      return false;
    }
  }

  async deleteEntry(path: string): Promise<void> {
    const st = await Filesystem.stat({ path, directory: this.dir });
    if (st.type === 'directory') {
      await Filesystem.rmdir({ path, directory: this.dir, recursive: true });
    } else {
      await Filesystem.deleteFile({ path, directory: this.dir });
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await Filesystem.rename({ from, to, directory: this.dir, toDirectory: this.dir });
  }

  /** Starter files so a new install is immediately usable. */
  async seedProject(project: string): Promise<void> {
    const root = this.projectRoot(project);
    await this.createProject(project);
    const files: Record<string, string> = {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zeno Project</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello from Zeno Editor</h1>
  <p id="out">Tap the button.</p>
  <button id="btn">Click me</button>
  <script src="script.js"></script>
</body>
</html>
`,
      'style.css': `body {
  font-family: system-ui, sans-serif;
  background: #0e0e10;
  color: #e6e6e6;
  text-align: center;
  padding: 2rem;
}
button {
  background: #00e676;
  border: 0;
  border-radius: 8px;
  padding: 0.7rem 1.2rem;
  font-weight: 700;
}
`,
      'script.js': `let count = 0;
document.getElementById('btn').addEventListener('click', () => {
  count++;
  document.getElementById('out').textContent = 'Clicked ' + count + ' times';
  console.log('Clicked', count);
});
`,
      'main.py': `def greet(name):
    return "Hello, " + name

for i in range(3):
    print(greet("Zeno"), i)
`
    };
    for (const [name, content] of Object.entries(files)) {
      await this.writeFile(`${root}/${name}`, content);
    }
  }
}
