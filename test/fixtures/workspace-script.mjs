import {readFile} from 'node:fs/promises';
export async function readWorkspaceScript(target='globalThis.page =') {
  const source=await readFile(new URL('../../band/src/common/workspace-page.mjs',import.meta.url),'utf8');
  return source.replace(/^import .*;\s*$/gm,'').replace('export default function','function')+
    '\n'+target+' createWorkspace({file,interconnect:typeof interconnect===\'undefined\'?null:interconnect});';
}
