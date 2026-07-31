import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt } from './prompt.js';

describe('buildClassificationPrompt', () => {
  it('embeds the categories description string into the system prompt', () => {
    const { system } = buildClassificationPrompt('- Category invoices: bills', 'facture.pdf', 'some text');
    expect(system).toContain('- Category invoices: bills');
  });

  it('truncates document text over 4000 chars in the user prompt, with an ellipsis', () => {
    const longText = 'a'.repeat(5000);
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', longText);
    expect(user).toContain('a'.repeat(4000) + '...');
    expect(user).not.toContain('a'.repeat(4001));
  });

  it('does not truncate document text at or under 4000 chars', () => {
    const shortText = 'b'.repeat(4000);
    const { user } = buildClassificationPrompt('categories', 'doc.pdf', shortText);
    expect(user).toContain(shortText);
    expect(user).not.toContain('...');
  });

  it('includes the filename in the user prompt', () => {
    const { user } = buildClassificationPrompt('categories', 'my_invoice.pdf', 'text');
    expect(user).toContain('Filename: my_invoice.pdf');
  });

  it('appends the previous-error feedback block only when previousError is provided', () => {
    const withoutError = buildClassificationPrompt('categories', 'doc.pdf', 'text');
    expect(withoutError.user).not.toContain('PREVIOUS ATTEMPT FEEDBACK');

    const withError = buildClassificationPrompt('categories', 'doc.pdf', 'text', 'subcategory was ungrounded');
    expect(withError.user).toContain('PREVIOUS ATTEMPT FEEDBACK');
    expect(withError.user).toContain('subcategory was ungrounded');
  });
});
