#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import chokidar from 'chokidar';
import fg from 'fast-glob';
import { z } from "zod";
import path from 'path';
import { analyzeFile } from './analyzer.js';
import { GraphStore } from './graph.js';

const server = new McpServer({
  name: "mcp-graphy",
  version: "1.2.0",
});

const store = new GraphStore();

// State
// @ts-ignore
let watchers: any[] = [];
let projectRoots: string[] = [];
let isIndexing = false;

// --- Tools ---

server.tool(
  "init_project",
  "Инициализировать индексацию PHP проекта. Поддерживает один или несколько путей.",
  { 
    paths: z.array(z.string()).describe("Массив абсолютных путей к папкам проекта"),
    ignore: z.array(z.string()).optional().describe("Глобальный список паттернов для игнорирования")
  },
  async ({ paths: inputPaths, ignore }) => {
    if (isIndexing) {
      return { content: [{ type: "text", text: "Indexation is already in progress. Please wait." }] };
    }
    
    // Reset previous state
    for (const w of watchers) {
      await w.close();
    }
    watchers = [];
    store.clear();

    // Normalize paths
    projectRoots = inputPaths.map(p => path.resolve(p));
    
    const ignorePatterns = ignore || [
      '**/vendor/**', 
      '**/node_modules/**', 
      '**/storage/**', 
      '**/cache/**',
      '**/.git/**'
    ];

    let totalFiles = 0;

    // 1. Initial scan for ALL roots
    for (const root of projectRoots) {
      try {
        const entries = await fg('**/*.php', { 
          cwd: root, 
          ignore: ignorePatterns,
          absolute: false,
          onlyFiles: true
        });
        
        console.error(`[PHP Graph] Found ${entries.length} files in ${root}`);
        totalFiles += entries.length;
        
        for (const entry of entries) {
          addToQueue(entry, root);
        }

        // 2. Start watcher for this root
        startWatcher(root, ignorePatterns);
      } catch (e) {
        console.error(`Failed to scan ${root}:`, e);
      }
    }

    return {
      content: [{
        type: "text",
        text: `Started indexing ${totalFiles} files across ${projectRoots.length} directories.`
      }]
    };
  }
);

server.tool(
  "search_symbol",
  "Найти PHP класс/интерфейс/трейт/enum и получить путь к файлу. Можно использовать как одинарные, так и двойные слеши.",
  { 
    query: z.string().describe("Имя символа (например 'App\\User' или 'App\\\\User')") 
  },
  async ({ query }) => {
    if (projectRoots.length === 0) return { content: [{ type: "text", text: "Error: No project initialized. Call init_project first." }] };
    
    const normalizedQuery = query.replace(/\\\\/g, '\\').trim();
    const results = store.search(normalizedQuery);
    
    const formatted = results.map(r => ({
      symbol: r.fqn,
      type: r.type,
      path: r.path,
      extends: r.extends,
      implements: r.implements,
      members: r.members.slice(0, 10), // Показываем топ-10 методов для контекста
      uses: Array.from(r.dependencies).slice(0, 5)
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify(formatted, null, 2)
      }]
    };
  }
);

server.tool(
  "get_inheritance",
  "Получить информацию о наследовании: кто наследует класс и кто реализует интерфейс.",
  { 
    fqn: z.string().describe("Полное имя класса или интерфейса") 
  },
  async ({ fqn }) => {
    if (projectRoots.length === 0) return { content: [{ type: "text", text: "Error: No project initialized." }] };
    
    const children = store.getInheritors(fqn);
    const implementors = store.getImplementors(fqn);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
            children,
            implementors
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "get_usages",
  "Найти файлы, которые используют указанный класс.",
  { 
    fqn: z.string().describe("Полное имя класса (FQN)") 
  },
  async ({ fqn }) => {
    if (projectRoots.length === 0) return { content: [{ type: "text", text: "Error: No project initialized." }] };
    
    const files = store.getUsages(fqn);
    return {
      content: [{
        type: "text",
        text: `Files depending on ${fqn}:\n` + JSON.stringify(files, null, 2)
      }]
    };
  }
);

server.tool(
  "get_graph_stats",
  "Получить статистику индекса",
  {},
  async () => {
      if (projectRoots.length === 0) return { content: [{ type: "text", text: "Project not initialized." }] };
      return {
          content: [{ type: "text", text: JSON.stringify(store.getStats(), null, 2) }]
      };
  }
);

// --- Watcher Logic ---

interface QueueItem {
  fullPath: string;
}

const workQueue: QueueItem[] = [];

async function startWatcher(root: string, ignored: string[]) {
  console.error(`[PHP Graph] Starting watcher in: ${root}`);
  
  const w = chokidar.watch('**/*.php', {
    cwd: root,
    ignored,
    persistent: true,
    ignoreInitial: true 
  });

  w.on('add', (p: string) => addToQueue(p, root))
   .on('change', (p: string) => addToQueue(p, root))
   .on('unlink', (p: string) => store.removeFile(path.join(root, p)))
   .on('ready', () => console.error(`[PHP Graph] Watcher ready for ${root}`));
   
   watchers.push(w);
}

const processWorkQueue = async () => {
  if (isIndexing || workQueue.length === 0) return;
  isIndexing = true;

  const batch = workQueue.splice(0, 10);
  
  await Promise.all(batch.map(async (item) => {
    try {
      const symbols = await analyzeFile(item.fullPath);
      store.updateFile(item.fullPath, symbols);
    } catch (e) {
      console.error(`Error processing ${item.fullPath}:`, e);
    }
  }));

  isIndexing = false;
  if (workQueue.length > 0) {
    setImmediate(processWorkQueue);
  }
};

const addToQueue = (relPath: string, root: string) => {
  if (!projectRoots.includes(root)) return;
  
  const fullPath = path.join(root, relPath);
  workQueue.push({ fullPath });
  processWorkQueue();
};

const transport = new StdioServerTransport();
await server.connect(transport);
