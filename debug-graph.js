import { analyzeFile } from './build/analyzer.js';
import { GraphStore } from './build/graph.js';
import path from 'path';
import fs from 'fs/promises';

const targetDir = path.resolve('php-test');
const store = new GraphStore();

async function walk(dir) {
    const files = await fs.readdir(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
            await walk(fullPath);
        } else if (file.endsWith('.php')) {
            console.log(`Analyzing ${fullPath}...`);
            const symbols = await analyzeFile(fullPath);
            store.updateFile(fullPath, symbols);
        }
    }
}

async function main() {
    console.log('--- Building Graph ---');
    await walk(targetDir);
    
    console.log('\n--- Graph Stats ---');
    console.log(store.getStats());

    console.log('\n--- Nodes & Dependencies ---');
    // Access internal symbols map for debugging (simulating what the graph knows)
    // Since symbols is private, we'll search for everything using a common prefix or iterate if we could, 
    // but here we will just search for common classes we expect to find.
    
    // Let's list all files and what they contain
    const files = await getAllPhpFiles(targetDir);
    
    for (const file of files) {
        // We can't easily get all symbols from store public API without search, 
        // so let's just re-analyze to know what to ask the store for, or modify GraphStore to debug.
        // Actually, let's just search for "Sdk" and "Config" etc.
    }

    // Better yet, let's just rely on the search tool logic.
    const allSymbols = store.search(""); // Search all
    
    for (const node of allSymbols) {
        console.log(`\n[${node.type}] ${node.fqn}`);
        console.log(`  File: ${path.relative(process.cwd(), node.path)}`);
        console.log(`  Depends on (${node.dependencies.size}):`);
        node.dependencies.forEach(dep => console.log(`    - ${dep}`));
        
        const usages = store.getUsages(node.fqn);
        if (usages.length > 0) {
            console.log(`  Used by (${usages.length}):`);
            usages.forEach(u => console.log(`    - ${path.relative(process.cwd(), u)}`));
        }
    }
}

async function getAllPhpFiles(dir, fileList = []) {
    const files = await fs.readdir(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            await getAllPhpFiles(filePath, fileList);
        } else if (file.endsWith('.php')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

main().catch(console.error);

