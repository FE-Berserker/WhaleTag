import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXT_PROTOCOL_VERSION,
  isSaveAckCurrent,
  isValidEnvelope,
  type HostMessage,
  type ExtensionMessage,
} from './extension-types';

function hostEnvelope(message: HostMessage) {
  return { protocolVersion: EXT_PROTOCOL_VERSION, source: 'host', message };
}

function extEnvelope(message: ExtensionMessage) {
  return { protocolVersion: EXT_PROTOCOL_VERSION, source: 'extension', message };
}


describe('isSaveAckCurrent', () => {
  it('keeps legacy acknowledgements backward compatible', () => {
    assert.equal(isSaveAckCurrent(undefined, undefined), true);
    assert.equal(isSaveAckCurrent(undefined, 3), true);
    assert.equal(isSaveAckCurrent(3, undefined), true);
  });

  it('accepts only an ack that covers the latest edit', () => {
    assert.equal(isSaveAckCurrent(2, 2), true);
    assert.equal(isSaveAckCurrent(3, 2), true);
    assert.equal(isSaveAckCurrent(1, 2), false);
  });
});

describe('isValidEnvelope', () => {
  it('accepts a live host message and rejects the wrong source', () => {
    assert.equal(
      isValidEnvelope(hostEnvelope({ type: 'siblings', current: 'a.png', paths: [] }), 'host'),
      true
    );
    assert.equal(
      isValidEnvelope(hostEnvelope({ type: 'siblings', current: 'a.png', paths: [] }), 'extension'),
      false
    );
  });

  it('accepts a live extension message', () => {
    assert.equal(
      isValidEnvelope(extEnvelope({ type: 'requestFileEmbed', path: 'a.pdf' }), 'extension'),
      true
    );
    assert.equal(
      isValidEnvelope(extEnvelope({ type: 'requestFile', path: 'b.png' }), 'extension'),
      true
    );
  });

  it('rejects unknown and retired message types', () => {
    for (const type of [
      'loadDefaultTextContent',
      'editDocument',
      'thumbnailGenerated',
      'directoryDialogResult',
      'notARealMessage',
    ]) {
      assert.equal(isValidEnvelope(hostEnvelope({ type } as never), 'host'), false, type);
      assert.equal(isValidEnvelope(extEnvelope({ type } as never), 'extension'), false, type);
    }
  });
});
