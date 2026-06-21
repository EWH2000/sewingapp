// Independent geometry check (no PDF): does the tiling cover the whole pattern,
// and do overlap bands fall on exactly 2 tiles? Re-derives constants from scratch.
const IN=72, MM=72/25.4, PW=612, PH=792, SAFE=13*MM, OV=0.5*IN;
const uW=PW-2*SAFE, uH=PH-2*SAFE, sX=uW-OV, sY=uH-OV;
for (const [name,Wmm,Hmm] of [["proof",300,380],["full",700,500]]) {
  const Wpt=Wmm*MM, Hpt=Hmm*MM;
  const cols=Math.max(1,Math.ceil((Wpt-OV)/sX)), rows=Math.max(1,Math.ceil((Hpt-OV)/sY));
  const win=[]; for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const gx0=c*sX,gy0=Hpt-r*sY-uH;win.push([gx0,gx0+uW,gy0,gy0+uH]);}
  const cover=(x,y)=>win.reduce((n,[a,b,d,e])=>n+((x>=a-1e-6&&x<=b+1e-6&&y>=d-1e-6&&y<=e+1e-6)?1:0),0);
  // sample the whole pattern extent on a fine grid
  let uncovered=0, maxc=0, N=160;
  for(let i=0;i<=N;i++)for(let j=0;j<=N;j++){const x=Wpt*i/N,y=Hpt*j/N;const n=cover(x,y);if(n<1)uncovered++;maxc=Math.max(maxc,n);}
  // sample the interior vertical seams: band center must be covered by exactly 2 cols (in mid rows)
  let bandsOK=true;
  for(let c=1;c<cols;c++){const gx=c*sX+OV/2;const y=Hpt/2;const n=cover(gx,y);if(cols>1 && rows>=1){/* mid-height may be in 1 or 2 rows; check a y solidly inside a single row band */}}
  // explicit overlap test: a point centered in the (col0,col1) band at a y inside row0 only
  let overlapMsg="n/a";
  if(cols>1){const gx=1*sX+OV/2; const gy=Hpt-0*sY-uH/2; overlapMsg=`band(col0|1) center covered by ${cover(gx,gy)} tiles (expect 2)`;}
  console.log(`[${name}] ${Wmm}x${Hmm}mm -> ${rows}x${cols}=${rows*cols} sheets`);
  console.log(`   coverage: ${uncovered===0?"COMPLETE (0 uncovered samples)":uncovered+" UNCOVERED samples"}; max overlap depth=${maxc}`);
  console.log(`   ${overlapMsg}`);
  // reconstructable dimension check: leftmost tile left edge <=0 and rightmost right edge >=Wpt
  const left=Math.min(...win.map(w=>w[0])), right=Math.max(...win.map(w=>w[1]));
  const bot=Math.min(...win.map(w=>w[2])), top=Math.max(...win.map(w=>w[3]));
  console.log(`   extent covered x[${left.toFixed(1)}..${right.toFixed(1)}] needs [0..${Wpt.toFixed(1)}]  y[${bot.toFixed(1)}..${top.toFixed(1)}] needs [0..${Hpt.toFixed(1)}]  -> ${(left<=1e-6&&right>=Wpt-1e-6&&bot<=1e-6&&top>=Hpt-1e-6)?"OK":"GAP!"}`);
}
