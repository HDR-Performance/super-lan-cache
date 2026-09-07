import http from 'node:http';
const data=Buffer.alloc(3145728,71);
http.createServer((req,res)=>{
 const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
 const start=match?Number(match[1]):0,end=match?Math.min(Number(match[2]||data.length-1),data.length-1):data.length-1;
 const headers={'Content-Type':'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes'};
 if(match)headers['Content-Range']=`bytes ${start}-${end}/${data.length}`;
 res.writeHead(match?206:200,headers);res.end(data.subarray(start,end+1));
}).listen(80,'0.0.0.0');
