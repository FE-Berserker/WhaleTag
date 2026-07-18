import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileIconCategory } from './file-icon';

describe('fileIconCategory', () => {
  it('maps a representative extension for every category', () => {
    const cases: Array<[string, string]> = [
      ['photo.jpg', 'image'],
      ['clip.mp4', 'video'],
      ['song.mp3', 'audio'],
      ['report.pdf', 'pdf'],
      ['letter.docx', 'word'],
      ['budget.xlsx', 'excel'],
      ['deck.pptx', 'ppt'],
      ['backup.zip', 'archive'],
      ['app.ts', 'typescript'],
      ['README.md', 'markdown'],
      ['notes.txt', 'text'],
      ['config.yaml', 'data'],
      ['data.json', 'json'],
      ['analysis.ipynb', 'notebook'],
      ['logo.psd', 'design'],
      ['receipt.eml', 'email'],
      ['shortcut.url', 'link'],
      ['installer.iso', 'diskimage'],
      ['novel.epub', 'ebook'],
      ['paper.caj', 'caj'],
      ['paper.CAJ', 'caj'],
      ['flow.drawio', 'drawio'],
      ['sketch.excalidraw', 'excalidraw'],
      ['brand.woff2', 'font'],
      ['part.stl', 'model3d'],
      ['setup.exe', 'executable'],
    ];
    for (const [name, category] of cases) {
      assert.equal(fileIconCategory(name), category, name);
    }
  });

  it('is case-insensitive on the extension', () => {
    assert.equal(fileIconCategory('IMAGE.PNG'), 'image');
    assert.equal(fileIconCategory('Doc.DOCX'), 'word');
    assert.equal(fileIconCategory('Archive.ZIP'), 'archive');
  });

  it('splits Office formats by document kind', () => {
    assert.equal(fileIconCategory('a.doc'), 'word');
    assert.equal(fileIconCategory('a.odt'), 'word');
    assert.equal(fileIconCategory('a.xls'), 'excel');
    assert.equal(fileIconCategory('a.csv'), 'excel');
    assert.equal(fileIconCategory('a.ppt'), 'ppt');
    assert.equal(fileIconCategory('a.odp'), 'ppt');
  });

  it('recognizes CAJ / CNKI viewer formats', () => {
    for (const name of ['a.caj', 'a.kdh', 'a.nh', 'a.caa', 'a.teb']) {
      assert.equal(fileIconCategory(name), 'caj', name);
    }
  });

  it('recognizes archive formats Whale cannot open (icon-only)', () => {
    for (const name of ['a.tar', 'a.gz', 'a.7z', 'a.rar', 'a.tgz']) {
      assert.equal(fileIconCategory(name), 'archive', name);
    }
  });

  it('falls back to generic for unknown extensions', () => {
    assert.equal(fileIconCategory('mystery.qwerty'), 'generic');
    assert.equal(fileIconCategory('data.xyz'), 'generic');
  });

  it('falls back to generic for names with no extension', () => {
    assert.equal(fileIconCategory('Makefile'), 'generic');
    assert.equal(fileIconCategory('LICENSE'), 'generic');
  });

  it('treats dotfiles (leading dot, no real extension) as generic', () => {
    assert.equal(fileIconCategory('.gitignore'), 'generic');
    assert.equal(fileIconCategory('.env'), 'generic');
  });

  it('uses the last extension for multi-dot names', () => {
    assert.equal(fileIconCategory('archive.tar.gz'), 'archive');
    assert.equal(fileIconCategory('app.min.js'), 'javascript');
  });

  it('recognizes common programming languages', () => {
    const cases: Array<[string, string]> = [
      ['app.js', 'javascript'],
      ['app.jsx', 'javascript'],
      ['app.ts', 'typescript'],
      ['app.tsx', 'typescript'],
      ['page.html', 'html'],
      ['page.htm', 'html'],
      ['style.css', 'css'],
      ['style.scss', 'css'],
      ['script.py', 'python'],
      ['Main.java', 'java'],
      ['main.c', 'cpp'],
      ['main.cpp', 'cpp'],
      ['main.h', 'cpp'],
      ['App.cs', 'csharp'],
      ['server.go', 'go'],
      ['lib.rs', 'rust'],
      ['deploy.sh', 'shell'],
      ['deploy.ps1', 'shell'],
      ['query.sql', 'database'],
      ['filter.m', 'matlab'],
      ['data.mat', 'matlab'],
      ['index.php', 'code'],
      ['Gemfile.rb', 'code'],
      ['App.vue', 'code'],
    ];
    for (const [name, category] of cases) {
      assert.equal(fileIconCategory(name), category, name);
    }
  });
});
