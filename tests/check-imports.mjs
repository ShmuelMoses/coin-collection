// Verifies that every name imported by a module is actually exported by the
// module it comes from, and that there are no import cycles. A missing export
// is silently `undefined` at runtime in a browser, so this is the check that
// replaces "the whole file was one scope and it obviously worked".
import fs from 'fs';
import path from 'path';

const DIR = 'js';
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));
const src = {};
files.forEach(f => { src[f] = fs.readFileSync(path.join(DIR, f), 'utf8'); });

function exportsOf(text) {
    const names = new Set();
    // export function foo / export async function foo / export class Foo
    for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
    for (const m of text.matchAll(/^export\s+class\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
    // export const/let/var foo
    for (const m of text.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
    // export { a, b as c }
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        m[1].split(',').forEach(part => {
            const t = part.trim();
            if (!t) return;
            const as = t.split(/\s+as\s+/);
            names.add((as[1] || as[0]).trim());
        });
    }
    return names;
}

function importsOf(text) {
    const out = [];
    for (const m of text.matchAll(/^import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/gms)) {
        const clause = m[1].trim();
        const from = m[2];
        const braced = clause.match(/\{([\s\S]*)\}/);
        const names = [];
        if (braced) {
            braced[1].split(',').forEach(part => {
                const t = part.trim();
                if (!t) return;
                names.push(t.split(/\s+as\s+/)[0].trim());
            });
        }
        out.push({ from, names });
    }
    return out;
}

let problems = 0;
const graph = {};

for (const f of files) {
    const imps = importsOf(src[f]);
    graph[f] = [];
    for (const imp of imps) {
        if (!imp.from.startsWith('./')) continue;
        const target = imp.from.replace('./', '');
        if (!src[target]) {
            console.log(`MISSING MODULE  ${f} imports "${imp.from}" which does not exist`);
            problems++;
            continue;
        }
        graph[f].push(target);
        const available = exportsOf(src[target]);
        for (const n of imp.names) {
            if (!available.has(n)) {
                console.log(`MISSING EXPORT  ${f} imports { ${n} } from ${target}, but ${target} does not export it`);
                problems++;
            }
        }
    }
}

// Unused imports are harmless but usually mean a leftover from the split.
for (const f of files) {
    for (const imp of importsOf(src[f])) {
        if (!imp.from.startsWith('./')) continue;
        const body = src[f].replace(/^import[^;]+;/gms, '');
        for (const n of imp.names) {
            const used = new RegExp(`\\b${n.replace('$', '\\$')}\\b`).test(body);
            if (!used) { console.log(`UNUSED IMPORT   ${f}: { ${n} } from ${imp.from}`); problems++; }
        }
    }
}

// Import cycles: legal in ESM but a live hazard (a binding can be read before
// its module body has run).
const WHITE = 0, GREY = 1, BLACK = 2;
const color = {};
files.forEach(f => { color[f] = WHITE; });
const stack = [];
function visit(f) {
    color[f] = GREY; stack.push(f);
    for (const t of (graph[f] || [])) {
        if (color[t] === GREY) {
            console.log(`IMPORT CYCLE    ${stack.slice(stack.indexOf(t)).join(' -> ')} -> ${t}`);
            problems++;
        } else if (color[t] === WHITE) visit(t);
    }
    stack.pop(); color[f] = BLACK;
}
files.forEach(f => { if (color[f] === WHITE) visit(f); });

console.log(problems ? `\n${problems} problem(s)` : '\nimports/exports all resolve, no cycles');
process.exit(problems ? 1 : 0);
