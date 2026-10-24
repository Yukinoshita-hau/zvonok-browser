import assert from 'node:assert/strict';
import {validAction} from './input-control.mjs';
for(const action of ['click','type','scroll'])assert(validAction({action}));
for(const bad of [null,{}, {action:'evaluate'}, {action:'click',code:'1'}, {action:'shell'}, {action:1}])assert(!validAction(bad));
console.log('input schema PASS');
