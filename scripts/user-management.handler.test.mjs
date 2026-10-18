import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

// Actual handler source runs with synthetic Supabase mocks and no process,
// inherited environment, fetch or real user/credential values in the VM.
const source=(path)=>readFileSync(new URL(path,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const actor='00000000-0000-4000-8000-000000000001';
const target='00000000-0000-4000-8000-000000000002';
const CANARY='SYNTHETIC_PRIVATE_CREDENTIAL_AND_PERSONAL_VALUE_DO_NOT_LOG';
function boot(options={}) {
  const state={rpcCalls:[],logs:[],authDeletes:0,handler:null};
  const appUser={id:actor,status:'active',role:'admin',display_name:'Synthetic admin',...options.appUser};
  const query={select(){return this;},eq(){return this;},maybeSingle:async()=>({data:appUser,error:null})};
  const client={
    auth:{getUser:async(token)=>{
      if(options.throwAuth) throw new Error(CANARY);
      return token==='SYNTHETIC_VALID_JWT'?{data:{user:{id:actor,email:'fixture@example.invalid',user_metadata:{}}},error:null}:{data:{user:null},error:{status:401}};
    },admin:{deleteUser:async()=>{state.authDeletes++;throw new Error('Unexpected Auth HTTP delete');}}},
    from:()=>query,
    rpc:async(name,args)=>{
      state.rpcCalls.push({name,args});
      if(options.throwRpc) throw new Error(CANARY);
      return {data:Object.hasOwn(options,'result')?options.result:{ok:true},error:options.rpcError?{message:CANARY}:null};
    },
  };
  vm.runInNewContext(stripTypeScriptTypes([
    source('../supabase/functions/_shared/auth.ts'),source('../supabase/functions/_shared/cors.ts'),source('../supabase/functions/v3-users/index.ts'),
  ].join('\n')),{
    Request,Response,Headers,
    createClient:()=>client,
    Deno:{env:{get:(name)=>({SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_BACKEND_KEY'})[name]},serve:handler=>{state.handler=handler;}},
    console:{error:(...args)=>state.logs.push(args)},
  },{timeout:1000});
  return state;
}
function request(body,authorization='Bearer SYNTHETIC_VALID_JWT') {
  return new Request('https://fixture.invalid/v3-users',{method:'POST',headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},body:JSON.stringify(body)});
}
async function output(state,req) {
  const response=await state.handler(req);
  return {status:response.status,body:await response.json()};
}
for(const body of [null,[],true,9,'invalid']) {
  test(`non-object JSON ${JSON.stringify(body)} returns a fixed 400`,async()=>{
    const state=boot();
    const result=await output(state,request(body));
    assert.deepEqual(result,{status:400,body:{error:'invalid json body'}});
    assert.equal(state.rpcCalls.length,0);
    assert.deepEqual(state.logs,[]);
  });
}
test('malformed JSON remains 400 without logging its content',async()=>{
  const state=boot();
  const result=await output(state,new Request('https://fixture.invalid',{method:'POST',body:'{'+CANARY}));
  assert.equal(result.status,400);
  assert.equal(JSON.stringify([result,state.logs]).includes(CANARY),false);
});
for(const authorization of ['', 'Bearer SYNTHETIC_INVALID_JWT']) {
  test(`missing or invalid JWT cannot reach admin RPC (${authorization?'invalid':'missing'})`,async()=>{
    const state=boot();
    assert.equal((await output(state,request({action:'list'},authorization))).status,401);
    assert.equal(state.rpcCalls.length,0);
  });
}
for(const appUser of [{status:'pending'},{status:'disabled'},{role:'viewer'}]) {
  test(`early approval/role check rejects ${JSON.stringify(appUser)}`,async()=>{
    const state=boot({appUser});
    assert.equal((await output(state,request({action:'list'}))).status,403);
    assert.equal(state.rpcCalls.length,0);
  });
}
test('admin RPC receives the verified actor, ignoring body identity fields',async()=>{
  const state=boot();
  assert.equal((await output(state,request({action:'disable',target_id:target,actor_id:target,p_actor_id:target,user_id:target}))).status,200);
  assert.equal(state.rpcCalls.length,1);
  assert.equal(state.rpcCalls[0].name,'v3_manage_users_atomic');
  assert.equal(state.rpcCalls[0].args.p_actor_id,actor);
  assert.equal(state.rpcCalls[0].args.p_target_id,target);
});
test('fresh database denial overrides an earlier admin precheck',async()=>{
  const state=boot({result:{ok:false,status:403,error:'このアカウントは現在利用できません'}});
  assert.deepEqual(await output(state,request({action:'disable',target_id:target})),{status:403,body:{error:'このアカウントは現在利用できません'}});
});
test('global list keeps the existing response shape',async()=>{
  const users=[{id:actor},{id:target}];
  const state=boot({result:{ok:true,users}});
  assert.deepEqual(await output(state,request({action:'list'})),{status:200,body:{users}});
});
test('delete response comes only from the atomic RPC, with no delayed Auth HTTP request',async()=>{
  const state=boot({result:{ok:true,auth_deleted:true}});
  assert.deepEqual(await output(state,request({action:'delete',target_id:target})),{status:200,body:{ok:true,auth_deleted:true}});
  assert.equal(state.authDeletes,0);
});
test('partial Auth deletion retains the existing warning response',async()=>{
  const warning='利用者は削除しましたが、ログイン情報（auth.users）の削除に失敗しました。Supabase の Authentication 画面から削除してください';
  const state=boot({result:{ok:true,auth_deleted:false,warning}});
  assert.deepEqual(await output(state,request({action:'delete',target_id:target})),{status:200,body:{ok:true,auth_deleted:false,warning}});
  assert.equal(state.authDeletes,0);
});
for(const options of [{throwAuth:true},{throwRpc:true},{rpcError:true}]) {
  test(`runtime/transport errors cannot expose private canaries ${JSON.stringify(options)}`,async()=>{
    const state=boot(options);
    const result=await output(state,request({action:'disable',target_id:target}));
    assert.equal(result.status,500);
    assert.equal(JSON.stringify([result,state.logs]).includes(CANARY),false);
    if(options.throwAuth||options.throwRpc) assert.deepEqual(state.logs,[['v3-users internal error']]);
    else assert.deepEqual(state.logs,[]);
  });
}
for(const result of [null,[],{}, {ok:'true'}, {ok:false,status:503,error:CANARY}, {ok:false,status:400}]) {
  test(`malformed RPC result is rejected without private values ${JSON.stringify(result).slice(0,25)}`,async()=>{
    const state=boot({result});
    const response=await output(state,request({action:'disable',target_id:target}));
    assert.equal(response.status,500);
    assert.equal(JSON.stringify([response,state.logs]).includes(CANARY),false);
  });
}
test('unknown action does not echo the supplied action',async()=>{
  const state=boot();
  const response=await output(state,request({action:CANARY}));
  assert.deepEqual(response,{status:400,body:{error:'unknown action'}});
  assert.equal(state.rpcCalls.length,0);
});
for(const target_id of [null,9,'',CANARY]) {
  test('invalid target ID fails before the database request',async()=>{
    const state=boot();
    const response=await output(state,request({action:'disable',target_id}));
    assert.equal(response.status,400);
    assert.equal(state.rpcCalls.length,0);
    assert.equal(JSON.stringify(response).includes(CANARY),false);
  });
}
