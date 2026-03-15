'use strict';
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const PORT=Number(process.env.PORT||3001);
const rooms=new Map(),clients=new Map();
const WS_MAGIC='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsHandshake(req,socket){
  const key=req.headers['sec-websocket-key'];
  if(!key){socket.destroy();return false;}
  const accept=crypto.createHash('sha1').update(key+WS_MAGIC).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  return true;
}
function buildFrame(payload){
  const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload,'utf8');
  const len=data.length;let hdr;
  if(len<126){hdr=Buffer.alloc(2);hdr[0]=0x81;hdr[1]=len;}
  else if(len<65536){hdr=Buffer.alloc(4);hdr[0]=0x81;hdr[1]=126;hdr.writeUInt16BE(len,2);}
  else{hdr=Buffer.alloc(10);hdr[0]=0x81;hdr[1]=127;hdr.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([hdr,data]);
}
function parseFrames(buf){
  const frames=[];let off=0;
  while(off+2<=buf.length){
    const b0=buf[off],b1=buf[off+1];
    const opcode=b0&0x0f,masked=(b1&0x80)!==0;
    let plen=b1&0x7f,hlen=2;
    if(plen===126){if(off+4>buf.length)break;plen=buf.readUInt16BE(off+2);hlen=4;}
    else if(plen===127){if(off+10>buf.length)break;plen=Number(buf.readBigUInt64BE(off+2));hlen=10;}
    if(masked)hlen+=4;
    if(off+hlen+plen>buf.length)break;
    let payload=buf.slice(off+hlen,off+hlen+plen);
    if(masked){const mask=buf.slice(off+hlen-4,off+hlen);payload=Buffer.from(payload.map((b,i)=>b^mask[i%4]));}
    frames.push({opcode,payload});off+=hlen+plen;
  }
  return{frames,rest:buf.slice(off)};
}
function sendJSON(socket,obj){
  try{if(!socket.destroyed)socket.write(buildFrame(JSON.stringify(obj)));}catch(_){}
}
function broadcast(roomId,obj,exclude=null){
  for(const[sock,info]of clients)
    if(info.room===roomId&&sock!==exclude&&!sock.destroyed)sendJSON(sock,obj);
}
function memberCount(roomId){
  let n=0;for(const[,info]of clients)if(info.room===roomId)n++;return n;
}

function handleMessage(socket,raw){
  let msg;try{msg=JSON.parse(raw);}catch{return;}
  const info=clients.get(socket)||{};

  if(msg.type==='join'){
    const{room,username}=msg;if(!room||!username)return;
    if(info.room){
      broadcast(info.room,{type:'sys',text:'👋 '+info.username+' غادر'},socket);
      broadcast(info.room,{type:'members',count:memberCount(info.room)},socket);
    }
    info.room=String(room).slice(0,80);
    info.username=String(username).slice(0,32);
    clients.set(socket,info);
    if(!rooms.has(info.room))rooms.set(info.room,[]);
    sendJSON(socket,{type:'history',messages:rooms.get(info.room)});
    broadcast(info.room,{type:'sys',text:'🔐 '+info.username+' انضم'},socket);
    const count=memberCount(info.room);
    broadcast(info.room,{type:'members',count},socket);
    sendJSON(socket,{type:'joined',room:info.room,count});

  }else if(msg.type==='msg'){
    if(!info.room||!info.username)return;
    const{enc,time,ts}=msg;
    if(typeof enc!=='string'||enc.length>200000)return;
    const stored={type:'msg',sender:info.username,enc,
      time:String(time||'').slice(0,8),ts:Number(ts||Date.now())};
    const hist=rooms.get(info.room)||[];
    hist.push(stored);
    if(hist.length>500)hist.splice(0,hist.length-500);
    rooms.set(info.room,hist);
    for(const[sock,c]of clients)
      if(c.room===info.room&&!sock.destroyed)sendJSON(sock,stored);

  }else if(msg.type==='file'){
    if(!info.room||!info.username)return;
    const{enc,fileId,name,size,mime,totalChunks,chunkIndex,time,ts}=msg;
    if(typeof enc!=='string'||enc.length>200000)return;
    if(typeof fileId!=='string')return;
    if(typeof chunkIndex!=='number'||typeof totalChunks!=='number')return;
    const stored={
      type:'file',sender:info.username,enc,
      fileId:String(fileId).slice(0,64),
      name:String(name||'file').slice(0,260),
      size:Number(size||0),
      mime:String(mime||'application/octet-stream').slice(0,100),
      totalChunks:Number(totalChunks),
      chunkIndex:Number(chunkIndex),
      time:String(time||'').slice(0,8),
      ts:Number(ts||Date.now())
    };
    const hist=rooms.get(info.room)||[];
    const dup=hist.some(m=>m.type==='file'&&m.fileId===stored.fileId&&m.chunkIndex===stored.chunkIndex);
    if(!dup){
      hist.push(stored);
      if(hist.length>5000)hist.splice(0,hist.length-5000);
      rooms.set(info.room,hist);
    }
    for(const[sock,c]of clients)
      if(c.room===info.room&&!sock.destroyed)sendJSON(sock,stored);

  }else if(msg.type==='typing'){
    if(info.room)broadcast(info.room,{type:'typing',username:info.username,typing:!!msg.typing},socket);

  }else if(msg.type==='ping'){
    sendJSON(socket,{type:'pong'});
  }
}

const server=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.url==='/health'){
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,rooms:rooms.size,clients:clients.size,uptime:Math.floor(process.uptime())}));
  }
  const file=path.join(__dirname,'index.html');
  if(fs.existsSync(file)){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(fs.readFileSync(file));
  }else{res.writeHead(404);res.end('index.html not found');}
});

server.on('upgrade',(req,socket)=>{
  if(req.headers.upgrade?.toLowerCase()!=='websocket'){socket.destroy();return;}
  if(!wsHandshake(req,socket))return;
  clients.set(socket,{room:null,username:null});
  let buf=Buffer.alloc(0);
  socket.on('data',chunk=>{
    buf=Buffer.concat([buf,chunk]);
    const{frames,rest}=parseFrames(buf);buf=rest;
    for(const f of frames){
      if(f.opcode===0x8){socket.destroy();return;}
      if(f.opcode===0x9){socket.write(buildFrame(Buffer.from([])));}
      if(f.opcode===0x1||f.opcode===0x2)handleMessage(socket,f.payload.toString('utf8'));
    }
  });
  socket.on('close',()=>{
    const info=clients.get(socket);
    if(info?.room){
      broadcast(info.room,{type:'sys',text:'👋 '+info.username+' غادر'});
      broadcast(info.room,{type:'members',count:memberCount(info.room)-1});
    }
    clients.delete(socket);
  });
  socket.on('error',()=>clients.delete(socket));
});

server.listen(PORT,()=>{
  console.log('\n\x1b[35m  🔐  VAULT CIPHER\x1b[0m');
  console.log('  \x1b[32m✓\x1b[0m  http://localhost:'+PORT);
  console.log('  \x1b[32m✓\x1b[0m  ws://localhost:'+PORT+'\n');
});