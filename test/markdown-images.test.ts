import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function render(text: string, user = false, agentId = 'flux') {
  const app = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  const markdown = app.slice(app.indexOf('const INLINE ='), app.indexOf('// ---------- cola ----------'));
  const context = vm.createContext({ URL, text, user, agentId });
  vm.runInContext(`
    class Element {
      constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; }
      append(...items) { this.children.push(...items); }
      replaceChildren(...items) { this.children = items; }
      addEventListener() {}
    }
    const document = { createElement: tag => new Element(tag) };
    const location = { origin: 'http://localhost:8787' };
    const state = { currentId: 'flux', paths: { shared: 'C:/data/shared' }, agents: [{ id: 'flux', workspace: 'C:/data/flux' }] };
    function libraryUrl(id, root, path) { return '/api/agents/' + id + '/library/file?root=' + root + '&path=' + encodeURIComponent(path); }
    ${markdown}
    const target = new Element('div');
    if (user) renderUserMessage({ text, agentId }, target);
    else renderMarkdown(text, target);
    globalThis.result = target;
  `, context);
  return context.result;
}

test('pasted user images render in the message and use the owning agent', () => {
  const text = 'Mira esta captura\n\nAdjunté este archivo en tu carpeta:\n- adjuntos/image con espacios.png';
  const result = images(render(text, true, 'other-agent'));
  assert.equal(result.length, 1);
  assert.equal(result[0].src, '/api/agents/other-agent/library/file?root=agent&path=adjuntos%2Fimage%20con%20espacios.png');
});

test('user attachments keep documents and ordinary text without interpreting markup', () => {
  assert.equal(images(render('![fake](https://example.com/tracker.png)\n- adjuntos/fake.png', true)).length, 0);
  assert.equal(images(render('Adjunté estos archivos en tu carpeta:\n- adjuntos/photo.jpg\n- adjuntos/readme.pdf\n- adjuntos/other.webp', true)).length, 2);
});

function images(node: any): any[] {
  if (typeof node !== 'object') return [];
  return [...(node.tagName === 'IMG' ? [node] : []), ...(node.children ?? []).flatMap(images)];
}

test('chat renders an existing local shared image through authenticated library', () => {
  const result = images(render('![Perro](file:///C:/data/shared/perro%20volando.png)'));
  assert.equal(result.length, 1);
  assert.equal(result[0].src, '/api/agents/flux/library/file?root=shared&path=perro%20volando.png');
  assert.equal(result[0].alt, 'Perro');
});

test('chat renders a relative library image and preserves code blocks as text', () => {
  const href = '/api/agents/flux/library/file?root=agent&path=output.png';
  assert.equal(images(render(`![Imagen](${href})`))[0]?.src, href);
  assert.equal(images(render('```\n![Imagen](' + href + ')\n```')).length, 0);
});

test('chat repairs the repeated workspace prefix returned by the local image agent', () => {
  const href = '/api/agents/flux/library/file?root=agent&path=agentes%2Fflux%2FHISOKA_HXH.png';
  const result = images(render(`![Imagen generada](${href})`));
  assert.equal(result[0]?.src, '/api/agents/flux/library/file?root=agent&path=HISOKA_HXH.png');
  const other = '/api/agents/flux/library/file?root=agent&path=agentes%2Fother%2FHISOKA.png';
  assert.equal(images(render(`![Imagen](${other})`))[0]?.src, other, 'never remap another workspace');
});

test('chat does not embed external images, executable formats or paths outside the library', () => {
  for (const href of ['https://tracker.example/image.png', 'javascript:alert(1)', 'file:///C:/secrets/photo.png', 'file:///C:/data/shared/../secrets/photo.png', '/api/agents/flux/library/file?root=agent&path=script.svg']) {
    assert.equal(images(render(`![Imagen](${href})`)).length, 0, href);
  }
});
