import { Engine } from 'php-parser';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type PhpType = 'class' | 'interface' | 'trait' | 'enum';

export interface ClassMember {
  name: string;
  type: 'method' | 'property' | 'constant';
  visibility: 'public' | 'protected' | 'private';
  static: boolean;
}

export interface SymbolDef {
  fqn: string;
  type: PhpType;
  path: string;
  extends?: string;
  implements: string[];
  traits: string[];
  dependencies: Set<string>;
  members: ClassMember[];
}

const IGNORED_TYPES = new Set([
  'string', 'int', 'float', 'bool', 'array', 'object', 'void', 'mixed', 
  'null', 'false', 'true', 'self', 'static', 'parent', 'iterable', 'callable'
]);

export async function analyzeFile(filePath: string): Promise<SymbolDef[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (e) {
    return [];
  }

  const engine = new Engine({
    parser: { extractDoc: false, suppressErrors: true },
    ast: { withPositions: true }
  });

  let ast;
  try {
    ast = engine.parseCode(content, path.basename(filePath));
  } catch (e) {
    return [];
  }

  const symbols: SymbolDef[] = [];
  let currentNamespace = '';
  let useImports = new Map<string, string>();

  const traverse = (node: any) => {
    if (!node) return;

    if (node.kind === 'namespace') {
      currentNamespace = node.name;
      useImports.clear();
      processChildren(node.children, traverse);
      return;
    }

    if (node.kind === 'usegroup') {
      node.items.forEach((item: any) => {
        const fullName = item.name;
        const alias = item.alias?.name || fullName.split('\\').pop();
        useImports.set(alias, fullName);
      });
      return;
    }

    if (['class', 'interface', 'trait', 'enum'].includes(node.kind)) {
      const name = node.name?.name || node.name;
      if (!name || typeof name !== 'string') return;

      const fqn = currentNamespace ? `${currentNamespace}\\${name}` : name;
      const deps = new Set<string>();
      const members: ClassMember[] = [];
      let parentClass: string | undefined;
      const implementedInterfaces: string[] = [];
      const usedTraits: string[] = [];

      // Helper to resolve FQN
      const resolveName = (n: any): string | null => {
        if (!n) return null;
        let rawName = '';
        let isFullyQualified = false;

        if (typeof n === 'string') {
          rawName = n;
        } else if (n.kind === 'name') {
          rawName = n.name;
          isFullyQualified = n.resolution === 'fqn';
        } else {
          return null;
        }

        if (IGNORED_TYPES.has(rawName.toLowerCase())) return null;

        if (isFullyQualified || rawName.startsWith('\\')) {
          return rawName.replace(/^\\/, '');
        }
        
        const parts = rawName.split('\\');
        const first = parts[0];
        if (useImports.has(first)) {
          const base = useImports.get(first)!;
          parts.shift();
          return parts.length > 0 ? `${base}\\${parts.join('\\')}` : base;
        }
        
        return currentNamespace ? `${currentNamespace}\\${rawName}` : rawName;
      };

      // 1. Extends
      if (node.extends) {
        // In PHP interfaces can extend multiple interfaces
        if (Array.isArray(node.extends)) {
             node.extends.forEach((ex: any) => {
                 const resolved = resolveName(ex);
                 if (resolved) {
                     deps.add(resolved);
                     // For interfaces, extends works like implements in a way, but strictly it's inheritance
                     // We will store the first one as parent or treat interface inheritance differently?
                     // For simplicity: store first as parent (mostly useful for classes)
                     if (!parentClass) parentClass = resolved; 
                 }
             });
        } else {
            const resolved = resolveName(node.extends);
            if (resolved) {
                deps.add(resolved);
                parentClass = resolved;
            }
        }
      }

      // 2. Implements
      if (node.implements) {
        node.implements.forEach((impl: any) => {
            const resolved = resolveName(impl);
            if (resolved) {
                deps.add(resolved);
                implementedInterfaces.push(resolved);
            }
        });
      }

      // 3. Body scan (Traits, Dependencies, Members)
      const scanBody = (bodyNode: any) => {
        if (!bodyNode) return;

        // Use Trait
        if (bodyNode.kind === 'traituse') {
            bodyNode.traits.forEach((t: any) => {
                const resolved = resolveName(t);
                if (resolved) {
                    deps.add(resolved);
                    usedTraits.push(resolved);
                }
            });
        }

        // Methods / Properties / Constants
        if (bodyNode.kind === 'method' || bodyNode.kind === 'property' || bodyNode.kind === 'constant') {
            const memberName = bodyNode.name?.name || bodyNode.name;
            if (typeof memberName === 'string') {
                members.push({
                    name: memberName,
                    type: bodyNode.kind,
                    visibility: bodyNode.visibility || 'public',
                    static: bodyNode.isStatic || false
                });
            }
        }

        // Dependencies logic (same as before)
        if (bodyNode.kind === 'new' && bodyNode.what) {
            const r = resolveName(bodyNode.what);
            if (r) deps.add(r);
        }
        if (bodyNode.kind === 'staticlookup' && bodyNode.what) {
            const r = resolveName(bodyNode.what);
            if (r) deps.add(r);
        }
        if (bodyNode.kind === 'parameter' && bodyNode.type) {
            const r = resolveName(bodyNode.type);
            if (r) deps.add(r);
        }
        if (bodyNode.type && (bodyNode.kind === 'returntype' || bodyNode.kind === 'method')) {
             // Handle return type
             // php-parser puts return type on the method node itself usually
             const typeNode = bodyNode.type; // could be identifier or name
             const r = resolveName(typeNode);
             if (r) deps.add(r);
        }

        // Recursion
        for (const key in bodyNode) {
          if (typeof bodyNode[key] === 'object') scanBody(bodyNode[key]);
        }
      };

      // Scan children
      processChildren(node.children || node.body, scanBody);

      symbols.push({
        fqn,
        type: node.kind as PhpType,
        path: filePath,
        extends: parentClass,
        implements: implementedInterfaces,
        traits: usedTraits,
        dependencies: deps,
        members
      });
    } else {
       // Continue traversal if not a class definition
       processChildren(node.children || node.body, traverse);
    }
  };

  processChildren(ast.children, traverse);
  return symbols;
}

function processChildren(children: any, visitor: (node: any) => void) {
    if (!children) return;
    if (Array.isArray(children)) {
        children.forEach(visitor);
    } else {
        visitor(children);
    }
}
