import { SymbolDef } from './analyzer.js';

export class GraphStore {
  // Core indices
  private symbols = new Map<string, SymbolDef>();
  private fileIndex = new Map<string, string[]>();
  
  // Dependency Graph
  private reverseDeps = new Map<string, Set<string>>();
  
  // Inheritance Graph (Parent -> Children)
  private inheritance = new Map<string, Set<string>>();
  
  // Interface Implementations (Interface -> Implementors)
  private implementations = new Map<string, Set<string>>();

  clear() {
    this.symbols.clear();
    this.fileIndex.clear();
    this.reverseDeps.clear();
    this.inheritance.clear();
    this.implementations.clear();
  }

  updateFile(filePath: string, newSymbols: SymbolDef[]) {
    this.removeFile(filePath);

    const fileFqns: string[] = [];

    for (const sym of newSymbols) {
      this.symbols.set(sym.fqn, sym);
      fileFqns.push(sym.fqn);

      // 1. Update Dependencies (Reverse Index)
      for (const depFqn of sym.dependencies) {
        const dependents = this.reverseDeps.get(depFqn) || new Set();
        dependents.add(sym.fqn);
        this.reverseDeps.set(depFqn, dependents);
      }

      // 2. Update Inheritance
      if (sym.extends) {
        const children = this.inheritance.get(sym.extends) || new Set();
        children.add(sym.fqn);
        this.inheritance.set(sym.extends, children);
      }

      // 3. Update Implementations
      for (const iface of sym.implements) {
        const impls = this.implementations.get(iface) || new Set();
        impls.add(sym.fqn);
        this.implementations.set(iface, impls);
      }
    }

    this.fileIndex.set(filePath, fileFqns);
  }

  removeFile(filePath: string) {
    const fqns = this.fileIndex.get(filePath);
    if (!fqns) return;

    for (const fqn of fqns) {
        this.symbols.delete(fqn);
    }
    this.fileIndex.delete(filePath);
  }

  search(query: string): SymbolDef[] {
    const lower = query.toLowerCase();
    return Array.from(this.symbols.values())
      .filter(s => s.fqn.toLowerCase().includes(lower))
      .slice(0, 20);
  }

  get(fqn: string): SymbolDef | undefined {
    return this.symbols.get(fqn);
  }

  getUsages(fqn: string): string[] {
    const dependentFqns = this.reverseDeps.get(fqn);
    if (!dependentFqns) return [];
    return this.mapFqnsToPaths(dependentFqns);
  }
  
  getInheritors(fqn: string): string[] {
      const children = this.inheritance.get(fqn);
      return children ? Array.from(children) : [];
  }

  getImplementors(fqn: string): string[] {
      const impls = this.implementations.get(fqn);
      return impls ? Array.from(impls) : [];
  }

  private mapFqnsToPaths(fqns: Set<string>): string[] {
    const files = new Set<string>();
    for (const fqn of fqns) {
      const sym = this.symbols.get(fqn);
      if (sym) files.add(sym.path);
    }
    return Array.from(files);
  }

  getStats() {
      return {
          nodes: this.symbols.size,
          files: this.fileIndex.size,
          edges: Array.from(this.reverseDeps.values()).reduce((acc, s) => acc + s.size, 0)
      };
  }
}
