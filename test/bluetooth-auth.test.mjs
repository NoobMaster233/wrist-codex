import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AuthSession,deriveKeys} from '../bridge/bluetooth/auth.mjs';
import {fields,last,pbBytes,pbNumber,wear} from '../bridge/bluetooth/protobuf.mjs';

const fixture=JSON.parse(await readFile(new URL('./fixtures/bluetooth-auth-synthetic.json',import.meta.url)));
const token=Buffer.from(fixture.token,'hex'),phone=Buffer.from(fixture.phoneNonce,'hex'),watch=Buffer.from(fixture.watchNonce,'hex');
const packet=(id,tag,payload)=>Buffer.concat([Buffer.from([1,1]),wear(1,id,3,pbBytes(tag,payload))]);
const challenge=()=>packet(26,31,Buffer.concat([pbBytes(1,watch),pbBytes(2,Buffer.from(fixture.deviceSign,'hex'))]));
const confirmation=value=>packet(27,33,pbNumber(1,value));

test('auth derivation and encrypted companion match independent Python HMAC/PyCryptodome vectors',()=>{
  const keys=deriveKeys(token,phone,watch),expected=Buffer.from(fixture.derived64,'hex');
  assert.deepEqual(keys.decKey,expected.subarray(0,16));assert.deepEqual(keys.encKey,expected.subarray(16,32));
  assert.deepEqual(keys.decNonce,expected.subarray(32,36));assert.deepEqual(keys.encNonce,expected.subarray(36,40));
  const auth=new AuthSession(token,phone),confirm=auth.challenge(challenge());
  assert.equal(auth.deviceHmacVerified,true);assert.equal(auth.authenticated,false);
  const account=last(fields(confirm.subarray(2)),3,2),body=last(fields(account.data),32,2);
  assert.equal(last(fields(body.data),2,2).data.toString('hex'),fixture.encryptedCompanion);
  assert.throws(()=>auth.encode(wear(20,0)),/not confirmed/);
  assert.equal(auth.confirm(confirmation(1)),true);assert.equal(auth.authenticated,true);
  assert.ok(auth.token.every(byte=>byte===0));assert.deepEqual(token,Buffer.from(fixture.token,'hex'));
});
test('wrong token or damaged signature produces no confirmation and no authenticated state',()=>{
  const wrong=Buffer.from(token);wrong[0]^=1;
  for(const [key,data] of [[wrong,challenge()],[token,Buffer.from(challenge())]]) {
    if(key===token)data[data.length-1]^=1;
    const auth=new AuthSession(key,phone);
    assert.throws(()=>auth.challenge(data),/does not match/);
    assert.equal(auth.deviceHmacVerified,undefined);assert.equal(auth.keys,undefined);assert.equal(auth.authenticated,false);
  }
});
test('auth rejects mismatched confirmation, early success and explicit device rejection',()=>{
  const auth=new AuthSession(token,phone);
  assert.equal(auth.challenge(Buffer.concat([Buffer.from([1,1]),wear(20,0)])),null);
  assert.throws(()=>auth.confirm(confirmation(1)),/before verified/);
  auth.challenge(challenge());assert.throws(()=>auth.confirm(confirmation(0)),/rejected/);
  assert.equal(auth.authenticated,false);
  const reject=Buffer.concat([Buffer.from([1,1]),wear(1,26,3,pbNumber(3,7))]);
  assert.throws(()=>new AuthSession(token,phone).challenge(reject),/code 7/);
});
test('BLE companion mode matches the independent encrypted iOS-mode vector',()=>{
  const auth=new AuthSession(token,phone,1),confirm=auth.challenge(challenge());
  const account=last(fields(confirm.subarray(2)),3,2),body=last(fields(account.data),32,2);
  assert.equal(last(fields(body.data),2,2).data.toString('hex'),fixture.encryptedCompanionIos);
  assert.throws(()=>new AuthSession(token,phone,15),/Unsupported/);
});
