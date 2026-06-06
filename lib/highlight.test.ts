import { describe, it, expect } from 'vitest';
import {
  buildRootMaps,
  locateHighlight,
  normWs,
  collapseWs,
  commonPrefixLen,
  commonSuffixLen,
} from './highlight';

const setBody = (html: string) => {
  document.body.innerHTML = html;
};

describe('whitespace helpers', () => {
  it('normWs collapses runs and trims the edges', () => {
    expect(normWs('  the   cat \n sat ')).toBe('the cat sat');
  });

  it('collapseWs collapses runs but keeps the edges (for prefix/suffix alignment)', () => {
    expect(collapseWs(' saw the ')).toBe(' saw the ');
    expect(collapseWs('a\n\nb')).toBe('a b');
  });

  it('commonPrefixLen / commonSuffixLen count the shared run', () => {
    expect(commonPrefixLen('abcd', 'abxy')).toBe(2);
    expect(commonSuffixLen('xycd', 'abcd')).toBe(2);
    expect(commonPrefixLen('', 'abc')).toBe(0);
    expect(commonSuffixLen('abc', '')).toBe(0);
  });
});

describe('buildRootMaps', () => {
  it('flattens text across element boundaries with an index-aligned map', () => {
    setBody('<div class="font-claude-response"><p>The <strong>cat</strong> sat</p></div>');
    const roots = buildRootMaps(document);
    expect(roots).toHaveLength(1);
    expect(roots[0].flat).toBe('The cat sat');
    expect(roots[0].map).toHaveLength('The cat sat'.length);
  });

  it('collapses whitespace runs (incl. across nodes)', () => {
    setBody('<div class="font-claude-response"><p>a   b\n\nc</p></div>');
    expect(buildRootMaps(document)[0].flat).toBe('a b c');
  });

  it('only walks assistant messages', () => {
    setBody('<p>not an answer</p><div class="font-claude-response"><p>answer</p></div>');
    const roots = buildRootMaps(document);
    expect(roots).toHaveLength(1);
    expect(roots[0].flat).toBe('answer');
  });
});

describe('locateHighlight', () => {
  const T = (highlightText: string, prefix = '', suffix = '') => ({ highlightText, prefix, suffix });

  it('returns a range over the highlight text', () => {
    setBody('<div class="font-claude-response"><p>The cat sat on the mat</p></div>');
    const r = locateHighlight(buildRootMaps(document), T('cat sat', 'The ', ' on'), new Set(), document);
    expect(r).not.toBeNull();
    expect(r!.toString()).toBe('cat sat');
  });

  it('matches a highlight that spans element boundaries', () => {
    setBody('<div class="font-claude-response"><p>The <strong>cat</strong> sat here</p></div>');
    const r = locateHighlight(buildRootMaps(document), T('cat sat'), new Set(), document);
    expect(r).not.toBeNull();
    expect(normWs(r!.toString())).toBe('cat sat');
  });

  it('returns null for text shorter than 3 chars', () => {
    setBody('<div class="font-claude-response"><p>hi there</p></div>');
    expect(locateHighlight(buildRootMaps(document), T('hi'), new Set(), document)).toBeNull();
  });

  it('disambiguates a repeated phrase using prefix/suffix', () => {
    setBody('<div class="font-claude-response"><p>red apple and green apple here</p></div>');
    const roots = buildRootMaps(document);
    const consumed = new Set<string>();
    // a tangent on "apple" preceded by "green " must land on the SECOND apple
    const second = locateHighlight(roots, T('apple', 'green ', ' here'), consumed, document);
    expect(second!.startOffset).toBe('red apple and green '.length);
    // another on "apple" preceded by "red " lands on the FIRST (and isn't blocked by `consumed`)
    const first = locateHighlight(roots, T('apple', 'red ', ' and'), consumed, document);
    expect(first!.startOffset).toBe('red '.length);
  });

  it('does not let two tangents claim the same occurrence', () => {
    setBody('<div class="font-claude-response"><p>apple pie</p></div>');
    const roots = buildRootMaps(document);
    const consumed = new Set<string>();
    expect(locateHighlight(roots, T('apple'), consumed, document)).not.toBeNull();
    // only one "apple" exists; the second request finds it consumed and returns null
    expect(locateHighlight(roots, T('apple'), consumed, document)).toBeNull();
  });

  it('tolerates whitespace differences between stored text and the DOM', () => {
    setBody('<div class="font-claude-response"><p>one   two\nthree</p></div>');
    const r = locateHighlight(buildRootMaps(document), T('two three'), new Set(), document);
    expect(r).not.toBeNull();
    expect(normWs(r!.toString())).toBe('two three');
  });
});
