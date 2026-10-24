export function pageCoordinates(rect: {left:number;top:number;width:number;height:number}, clientX:number, clientY:number) {
  const scale=Math.min(rect.width/1280,rect.height/720);
  if(!Number.isFinite(scale) || scale<=0) return undefined;
  const x=(clientX-rect.left-(rect.width-1280*scale)/2)/scale;
  const y=(clientY-rect.top-(rect.height-720*scale)/2)/scale;
  if(x<0 || x>=1280 || y<0 || y>=720) return undefined;
  return {x:Math.floor(x),y:Math.floor(y)};
}
