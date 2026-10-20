/** Controlled rich page with independent colour markers and a route-change button. */
export const sourceHtml = `<!doctype html><title>Identical prototype title</title>
<style>html,body{margin:0;background:white;font:16px sans-serif;overflow:hidden}canvas{position:absolute;inset:0;width:100%;height:100%}button{position:absolute;top:24px;left:160px;z-index:2}</style>
<canvas></canvas><button id=route>Switch page</button><script>
const c=document.querySelector('canvas'),g=c.getContext('2d');let green=false;window.serial=0;
const second=new URL(location.href).searchParams.has('second');window.transitions=[];
function draw(){if(c.width!==innerWidth*devicePixelRatio||c.height!==innerHeight*devicePixelRatio){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio}const s=devicePixelRatio;g.setTransform(s,0,0,s,0,0);g.fillStyle='white';g.fillRect(0,0,innerWidth,innerHeight);g.fillStyle='#222';g.font='18px sans-serif';for(let y=120;y<innerHeight;y+=32)g.fillText('Readable text123456789. The quick brown fox jumps over the lazy dog. '+y,20,y);const gradient=g.createLinearGradient(0,0,400,400);gradient.addColorStop(0,'#ffc040');gradient.addColorStop(0.5,'#20d0b0');gradient.addColorStop(1,'#a040ff');g.fillStyle=gradient;g.fillRect(innerWidth-420,160,400,400);g.fillStyle=green?'#00ff00':second?'#0000ff':'#ff0000';g.fillRect(0,0,96,96);g.fillStyle='#345';g.fillRect(120+(window.serial*5%(innerWidth-300)),90,40,20);window.serial++;requestAnimationFrame(draw)}
route.onclick=()=>{window.transitions.push(performance.timeOrigin+performance.now());green=!green;history.pushState({},'',green?'?faq'+(second?'&second=1':''):'/'+(second?'?second=1':''))};requestAnimationFrame(draw);
</script>`;
