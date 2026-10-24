import { describe, it, expect } from 'vitest';
import { pageCoordinates } from './coordinates';
describe('contain coordinates',()=>{
  it('rejects letterbox, maps scaled centre and edges',()=>{
    const rect={left:10,top:20,width:640,height:720};
    expect(pageCoordinates(rect,330,380)).toEqual({x:640,y:360});
    expect(pageCoordinates(rect,330,21)).toBeUndefined();
    expect(pageCoordinates(rect,10,200)).toEqual({x:0,y:0});
    expect(pageCoordinates(rect,650,380)).toBeUndefined();
    expect(pageCoordinates({left:0,top:0,width:0,height:0},0,0)).toBeUndefined();
  });
  it('maps narrow viewport with side letterboxing',()=>{
    const rect={left:0,top:0,width:360,height:100};
    expect(pageCoordinates(rect,180,50)).toEqual({x:640,y:360});
    expect(pageCoordinates(rect,0,50)).toBeUndefined();
  });
});
