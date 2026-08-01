/**
 * Unit tests for md-toolbar's PDF export template helpers (Typora-style
 * header/footer → Chromium printToPDF). The helpers are pure; global-jsdom is
 * set up only because importing md-toolbar pulls in md-context, which reads
 * localStorage at module load.
 */
import globalJsdom from 'global-jsdom';

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toChromiumPdfTemplate, pdfExportOptions } from './md-toolbar';

before(() => {
  globalJsdom();
});

describe('toChromiumPdfTemplate', () => {
  it('converts ${page} to a pageNumber span', () => {
    assert.equal(
      toChromiumPdfTemplate('${page}'),
      '<span class="pageNumber"></span>'
    );
  });
  it('converts ${pages} to a totalPages span', () => {
    assert.equal(
      toChromiumPdfTemplate('${pages}'),
      '<span class="totalPages"></span>'
    );
  });
  it('converts ${title} to a title span', () => {
    assert.equal(
      toChromiumPdfTemplate('${title}'),
      '<span class="title"></span>'
    );
  });
  it('converts ${date} to a date span', () => {
    assert.equal(
      toChromiumPdfTemplate('${date}'),
      '<span class="date"></span>'
    );
  });
  it('converts a mixed template', () => {
    assert.equal(
      toChromiumPdfTemplate('${title} - ${page}/${pages}'),
      '<span class="title"></span> - <span class="pageNumber"></span>/<span class="totalPages"></span>'
    );
  });
  it('leaves unknown placeholders like ${author} untouched', () => {
    assert.equal(
      toChromiumPdfTemplate('${author} p.${page}'),
      '${author} p.<span class="pageNumber"></span>'
    );
  });
  it('passes through a literal string with no placeholders', () => {
    assert.equal(toChromiumPdfTemplate('Confidential'), 'Confidential');
  });
  it('returns empty for empty input', () => {
    assert.equal(toChromiumPdfTemplate(''), '');
  });
});

describe('pdfExportOptions', () => {
  it('returns undefined when both header and footer are empty', () => {
    assert.equal(pdfExportOptions('', ''), undefined);
    assert.equal(pdfExportOptions('   ', '\t'), undefined);
  });
  it('enables header/footer and wraps the header when only header is set', () => {
    const o = pdfExportOptions('${page}', '');
    assert.equal(o?.displayHeaderFooter, true);
    assert.match(o!.headerTemplate, /pageNumber/);
    // empty side gets a bare div (no fallback to Chromium's default url/title)
    assert.equal(o!.footerTemplate, '<div></div>');
  });
  it('enables header/footer and wraps the footer when only footer is set', () => {
    const o = pdfExportOptions('', '${page} / ${pages}');
    assert.equal(o?.displayHeaderFooter, true);
    assert.equal(o!.headerTemplate, '<div></div>');
    assert.match(o!.footerTemplate, /pageNumber/);
    assert.match(o!.footerTemplate, /totalPages/);
  });
  it('wraps both when both are set', () => {
    const o = pdfExportOptions('${title}', '${date}');
    assert.match(o!.headerTemplate, /class="title"/);
    assert.match(o!.footerTemplate, /class="date"/);
  });
});
