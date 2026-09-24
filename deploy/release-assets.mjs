import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const {version}=JSON.parse(readFileSync('package.json','utf8'));
const digest=readFileSync('image-digest.txt','utf8').trim();
if(!/^ghcr\.io\/hdr-performance\/super-lan-cache@sha256:[a-f0-9]{64}$/.test(digest))throw Error('Invalid image digest');
const template=readFileSync('deploy/truenas.yaml','utf8');
const tag='ghcr.io/hdr-performance/super-lan-cache:'+version;
if(!template.includes(tag))throw Error('Installer version mismatch');
writeFileSync('super-lan-cache-truenas.yaml',template.replaceAll(tag,digest),{flag:'wx'});
const files=[
 {source:'super-lan-cache-truenas.yaml',name:'super-lan-cache-truenas.yaml'},
 {source:'image-digest.txt',name:'image-digest.txt'},
 {source:'branding/icon.png',name:'icon.png'},
 {source:'branding/icon.svg',name:'icon.svg'}
];
writeFileSync('SHA256SUMS.txt',files.map(f=>createHash('sha256').update(readFileSync(f.source)).digest('hex')+'  '+f.name+'\n').join(''),{flag:'wx'});
