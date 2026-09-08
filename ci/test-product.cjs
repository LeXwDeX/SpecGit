const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=process.cwd();
const product=path.join(root,'product');
const fresh=process.argv[2]==='fresh';
const nonRoot=process.platform==='linux'&&process.getuid()===0;
function own(directory){
 const s=fs.lstatSync(directory);
 if(s.isSymbolicLink()) return;
 fs.chownSync(directory,1000,1000);
 if(s.isDirectory()) for(const entry of fs.readdirSync(directory)) own(path.join(directory,entry));
}
if(nonRoot){
 own(product);
 fs.chownSync(process.env.HOME,1000,1000);
 const parent=path.dirname(root);
 if(path.basename(parent).startsWith('specgit-verification-snapshot-'))fs.chmodSync(parent,0o755);
}
const env={...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:root};
const commands=fresh?
 [['install','--frozen-lockfile','--ignore-scripts'],['exec','vitest','run','test/documentation-links.test.ts','test/specgit-cli/metadata-content.test.ts']]:
 [['install','--frozen-lockfile','--ignore-scripts'],['run','build'],['exec','vitest','run','--exclude','test/documentation-links.test.ts','--exclude','test/specgit-cli/metadata-content.test.ts']];
for(const args of commands){
 const result=spawnSync('pnpm',args,{cwd:product,env,stdio:'inherit',...(nonRoot?{uid:1000,gid:1000}:{})});
 if(result.error||result.status!==0)process.exit(result.status||1);
}
