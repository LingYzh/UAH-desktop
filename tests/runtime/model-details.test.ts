import assert from 'node:assert/strict';
import test from 'node:test';
import { extractModelDetails } from '../../src/runtime/model-details';

test('capability extraction preserves explicit false, excludes unknown values and never infers by model name', () => {
    assert.deepEqual(extractModelDetails('vision-thinking-tools-model', {id:'vision-thinking-tools-model'}), {id:'vision-thinking-tools-model'});
    assert.deepEqual(extractModelDetails('a', {supports_tools:false,capabilities:['tools','vision','thinking','streaming'],supports_vision:false,supports_reasoning:false,supports_streaming:false,context_length:-1,max_output_tokens:'8000',api_key:'secret',input_modalities:['secret']}), {id:'a',imageInput:false,tools:false,vision:false,reasoning:false,streaming:false});
    assert.deepEqual(extractModelDetails('a', {supported_parameters:['tools','reasoning_effort'],input_modalities:['text','text','image','secret'],output_modalities:['audio'],max_output_tokens:8000}), {id:'a',imageInput:true,pdfInput:false,audioInput:false,videoInput:false,inputModalities:['text','image'],outputModalities:['audio'],maxOutputTokens:8000,tools:true,vision:true,reasoning:true});
});


test('mobile-compatible native media declarations respect explicit false and distinguish PDF from generic attachments', () => {
    assert.deepEqual(extractModelDetails('a', {capabilities:{image_input:{supported:true},pdf_input:{supported:true},input:{audio:false,video:true}}}), {id:'a',imageInput:true,pdfInput:true,audioInput:false,videoInput:true,vision:true});
    assert.deepEqual(extractModelDetails('b', {capabilities:{input:{image:false,pdf:false}},inputModalities:['IMAGE','PDF','audio']}), {id:'b',imageInput:false,pdfInput:false,audioInput:true,videoInput:false,vision:false,inputModalities:['image','pdf','audio']});
    assert.deepEqual(extractModelDetails('c', {capabilities:{attachment:true},output_modalities:['image','audio']}), {id:'c',outputModalities:['image','audio']});
    assert.equal(extractModelDetails('d', {architecture:{input_modalities:['file']}}).pdfInput, true);
});
