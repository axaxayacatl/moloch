const http = require("http");
const WebSocket = require("ws");

const PORT = 8080;
const TICK_RATE = 30;
const NET_RATE = 15;

const WORLD = { w: 1920, h: 1080 };

const SIGILS = [
  [255, 80, 80],
  [80, 160, 255],
  [80, 255, 140],
  [255, 200, 80]
];

const INPUT_RATE_LIMIT_MS = 30;
const HEARTBEAT_INTERVAL = 5000;
const TIMEOUT = 15000;

function rand(a,b){ return Math.random()*(b-a)+a; }


let players = new Map();
let houses = [];
let nextId = 1;

function spawnHouses(){
  houses = [];
  for(let i=0;i<14;i++){
    houses.push({
      id:i,
      x:rand(100,WORLD.w-100),
      y:rand(100,WORLD.h-100),
      r:60,
      owner:null
    });
  }
}
spawnHouses();


function createPlayer(){
  return {
    id: nextId++,
    x: WORLD.w/2,
    y: WORLD.h/2,
    vx:0,
    vy:0,
    sigil: Math.floor(Math.random()*4),
    input:{up:false,down:false,left:false,right:false},
    lastInput:0,
    lastSeen:Date.now()
  };
}


const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>MOLOCH PUBLIC</title>
<style>
html,body{margin:0;overflow:hidden;background:black}
canvas{display:block}
</style>
</head>
<body>
<canvas id="c"></canvas>

<script>
const ws = new WebSocket("ws://" + location.host);

const c = document.getElementById("c");
const x = c.getContext("2d");

let WORLD = {w:1920,h:1080};
let myId = null;
let state = {players:[],houses:[]};
let last = null;
let alpha = 0;

function resize(){ c.width=innerWidth; c.height=innerHeight; }
addEventListener("resize",resize); resize();

let keys={};
addEventListener("keydown",e=>keys[e.key]=true);
addEventListener("keyup",e=>keys[e.key]=false);

ws.onmessage = e=>{
  const d = JSON.parse(e.data);
  if(d.type==="init"){
    myId=d.id;
    WORLD=d.world;
  }
  if(d.type==="state"){
    last=state;
    state=d;
    alpha=0;
  }
};

function send(){
  if(ws.readyState!==1) return;
  ws.send(JSON.stringify({
    type:"input",
    input:{
      up:!!keys["ArrowUp"],
      down:!!keys["ArrowDown"],
      left:!!keys["ArrowLeft"],
      right:!!keys["ArrowRight"]
    }
  }));
}
setInterval(send,50);

function lerp(a,b,t){return a+(b-a)*t;}

function draw(){
  x.fillStyle="rgba(0,0,0,0.25)";
  x.fillRect(0,0,c.width,c.height);

  for(let h of state.houses){
    x.fillStyle=h.owner?"rgba(0,255,140,0.4)":"rgba(200,200,255,0.15)";
    x.beginPath();
    x.arc(h.x,h.y,h.r,0,7);
    x.fill();
  }

  for(let p of state.players){
    let px=p.x,py=p.y;

    if(last){
      let o=last.players.find(q=>q.id===p.id);
      if(o){
        px=lerp(o.x,p.x,alpha);
        py=lerp(o.y,p.y,alpha);
      }
    }

    x.fillStyle = p.id===myId?"white":"rgba(255,255,255,0.6)";
    x.beginPath();
    x.arc(px,py,4,0,7);
    x.fill();
  }

  alpha+=0.15;
  requestAnimationFrame(draw);
}
draw();
</script>
</body>
</html>
`;

const server = http.createServer((req,res)=>{
  res.writeHead(200,{"Content-Type":"text/html"});
  res.end(html);
});


const wss = new WebSocket.Server({ server });

wss.on("connection",(ws)=>{

  const p = createPlayer();
  players.set(p.id,p);

  ws.isAlive = true;

  ws.send(JSON.stringify({
    type:"init",
    id:p.id,
    world:WORLD
  }));

  ws.on("pong",()=>ws.isAlive=true);

  ws.on("message",(msg)=>{
    let d;
    try{d=JSON.parse(msg);}catch{return;}

    if(d.type==="input"){
      const now=Date.now();
      if(now - p.lastInput < INPUT_RATE_LIMIT_MS) return;
      p.lastInput = now;

      const i=d.input||{};
      p.input={
        up:!!i.up,
        down:!!i.down,
        left:!!i.left,
        right:!!i.right
      };

      p.lastSeen = now;
    }
  });

  ws.on("close",()=>{
    players.delete(p.id);
    for(let h of houses){
      if(h.owner===p.id) h.owner=null;
    }
  });
});


function update(){
  for(let p of players.values()){
    let a=0.18;

    if(p.input.up)p.vy-=a;
    if(p.input.down)p.vy+=a;
    if(p.input.left)p.vx-=a;
    if(p.input.right)p.vx+=a;

    p.vx*=0.92;
    p.vy*=0.92;

    p.x+=p.vx;
    p.y+=p.vy;

    p.x=Math.max(0,Math.min(WORLD.w,p.x));
    p.y=Math.max(0,Math.min(WORLD.h,p.y));

    for(let h of houses){
      let d=Math.hypot(p.x-h.x,p.y-h.y);
      if(d<h.r) h.owner=p.id;
    }
  }
}


function broadcast(){
  const msg=JSON.stringify({
    type:"state",
    players:[...players.values()],
    houses
  });

  for(let c of wss.clients){
    if(c.readyState===1 && c.bufferedAmount<1e6){
      c.send(msg);
    }
  }
}

setInterval(()=>{
  update();
  broadcast();
},1000/TICK_RATE);


setInterval(()=>{
  for(let c of wss.clients){
    if(!c.isAlive){
      c.terminate();
      continue;
    }
    c.isAlive=false;
    c.ping();
  }

  const now=Date.now();
  for(let p of players.values()){
    if(now - p.lastSeen > TIMEOUT){
      players.delete(p.id);
    }
  }
},HEARTBEAT_INTERVAL);

server.listen(PORT,()=>{
  console.log("PUBLIC MMO running on http://localhost:"+PORT);
});
