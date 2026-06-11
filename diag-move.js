'use strict';
const PORT = process.env.PORT || 3011;
const URL = `ws://localhost:${PORT}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function mk(name){return new Promise(res=>{const ws=new WebSocket(URL);const c={ws,name,id:null,last:null};ws.onopen=()=>ws.send(JSON.stringify({t:'join',name}));ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.t==='welcome')c.id=m.id;else if(m.t==='state')c.last=m;};setTimeout(()=>res(c),300);});}
(async()=>{
  const A=await mk('Alice');const B=await mk('Bob');
  await sleep(500);
  const aCell=A.last.cells.find(c=>c.owner===A.id);
  console.log('A.id',A.id,'aCell',aCell&&[aCell.x,aCell.y]);
  const aInB = B.last.blips.filter(b=>b.owner===A.id);
  console.log('A blips in B BEFORE move:', aInB.length, JSON.stringify(aInB));
  let push=setInterval(()=>A.ws.send(JSON.stringify({t:'input',dx:1000,dy:600})),50);
  await sleep(1300); clearInterval(push);
  const aInB2=B.last.blips.filter(b=>b.owner===A.id);
  const aAlive=A.last.you&&A.last.you.alive;
  console.log('A.you.alive after move:', aAlive, 'mass', A.last.you&&A.last.you.mass, 'cells', A.last.you&&A.last.you.cells);
  console.log('A blips in B AFTER move:', aInB2.length, JSON.stringify(aInB2));
  A.ws.close();B.ws.close();await sleep(150);process.exit(0);
})();
