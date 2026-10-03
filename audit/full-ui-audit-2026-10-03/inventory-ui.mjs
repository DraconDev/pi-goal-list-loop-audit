import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const root = process.cwd();
const files = [];
function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const name = path.join(dir,entry.name); if(entry.isDirectory()) walk(name); else if(name.endsWith('.ts')) files.push(name); } }
walk('extensions');
const calls = [], components = [], commands = [], messageRenderers = [];
for (const file of files) {
 const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true);
 function visit(node) {
  const line = source.getLineAndCharacterOfPosition(node.getStart()).line+1;
  if(ts.isClassDeclaration(node) && node.name && /Component$/.test(node.name.text)) components.push({file,line,name:node.name.text});
  if(ts.isCallExpression(node)) {
   const name = node.expression.getText(source);
   if(/\.ui\.(custom|select|input|confirm|notify|setWidget|setStatus)$/.test(name)) calls.push({file,line,kind:name.split('.').at(-1),content:node.arguments[0]?.getText(source).slice(0,600)});
   if(/\.registerMessageRenderer$/.test(name)) messageRenderers.push({file,line,name:node.arguments[0]?.getText(source)});
   if(/\.registerCommand$/.test(name)) commands.push({file,line,name:node.arguments[0]?.getText(source)});
  }
  ts.forEachChild(node, visit);
 }
 visit(source);
}
const counts = {};
for(const call of calls) counts[call.kind]=(counts[call.kind]??0)+1;
const result = {components,messageRenderers,commands,counts,calls};
fs.writeFileSync('audit/full-ui-audit-2026-10-03/surface-inventory.json', JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({components,messageRenderers,commands,counts},null,2));
