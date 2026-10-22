import test from 'node:test';
import assert from 'node:assert/strict';
import { trusted, createHandler } from '../src/routes.js';
const request = () => ({method:'GET', url:'/api/server-ops-monitor/snapshot?connectionId=a', socket:{remoteAddress:'127.0.0.1'}, headers:{host:'127.0.0.1:59846',origin:'http://127.0.0.1:59846','sec-fetch-site':'same-origin'}});
const connection = {requestRejection:()=>undefined};
test('authentication must exist and accept; local and same-origin required',()=>{
 assert.equal(trusted(request(),connection),true);
 assert.equal(trusted(request(),{}),false);
 assert.equal(trusted(request(),{requestRejection:()=>({status:401})}),false);
 const cross=request();cross.headers.origin='https://attacker.invalid';assert.equal(trusted(cross,connection),false);
 const remote=request();remote.socket.remoteAddress='192.168.1.2';assert.equal(trusted(remote,connection),false);
});
test('explicit host binding is required; only GET is accepted',async()=>{
 const observed=[];const handler=createHandler({getSnapshot:async id=>{observed.push(id);return {ok:true}}},connection);
 const res={setHeader(){},end(body){this.body=JSON.parse(body)}};
 await handler(request(),res);assert.equal(res.statusCode,200);assert.deepEqual(observed,['a']);
 await handler({...request(),url:'/api/server-ops-monitor/snapshot'},res);assert.equal(res.statusCode,400);
 await handler({...request(),method:'POST'},res);assert.equal(res.statusCode,405);
});
