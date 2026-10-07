/** Sample parsed email objects mimicking mailparser's ParsedMail structure */

export const validNewsletterEmail = {
  messageId: '<abc123@mail.example.com>',
  from: {
    value: [{ address: 'ben@stratechery.com', name: 'Ben Thompson' }],
    text: 'Ben Thompson <ben@stratechery.com>',
  },
  to: {
    value: [{ address: 'inbox@reader.example.com', name: '' }],
    text: 'inbox@reader.example.com',
  },
  subject: 'The Latest Tech Analysis',
  date: new Date('2026-03-10T08:00:00Z'),
  html: '<h1>Hello</h1><p>This is a newsletter with enough words to form a proper article. It contains multiple paragraphs of interesting content about technology and business strategy.</p><p>Second paragraph with more content here to make the word count reasonable.</p>',
  text: 'Hello\n\nThis is a newsletter with enough words to form a proper article. It contains multiple paragraphs of interesting content about technology and business strategy.\n\nSecond paragraph with more content here to make the word count reasonable.',
  headers: new Map([
    ['message-id', '<abc123@mail.example.com>'],
    ['delivered-to', 'inbox@reader.example.com'],
  ]),
};

export const plainTextOnlyEmail = {
  messageId: '<plain456@mail.example.com>',
  from: {
    value: [{ address: 'writer@blog.com', name: 'Plain Writer' }],
    text: 'Plain Writer <writer@blog.com>',
  },
  to: {
    value: [{ address: 'inbox@reader.example.com', name: '' }],
    text: 'inbox@reader.example.com',
  },
  subject: 'Plain Text Newsletter',
  date: new Date('2026-03-09T12:00:00Z'),
  html: false as const,
  text: 'This is a plain text email newsletter. It has no HTML content but still has useful information worth reading.',
  headers: new Map([['message-id', '<plain456@mail.example.com>']]),
};

export const duplicateEmail = {
  ...validNewsletterEmail,
  messageId: '<duplicate@mail.example.com>',
  headers: new Map([['message-id', '<duplicate@mail.example.com>']]),
};

export const largeEmail = {
  messageId: '<large@mail.example.com>',
  from: {
    value: [{ address: 'large@example.com', name: 'Large Sender' }],
    text: 'Large Sender <large@example.com>',
  },
  to: {
    value: [{ address: 'inbox@reader.example.com', name: '' }],
    text: 'inbox@reader.example.com',
  },
  subject: 'Huge Newsletter',
  date: new Date('2026-03-09T12:00:00Z'),
  html: '<p>' + 'x'.repeat(6 * 1024 * 1024) + '</p>',
  text: 'x'.repeat(6 * 1024 * 1024),
  headers: new Map([['message-id', '<large@mail.example.com>']]),
};

/** Email with multiple recipients */
export const multiRecipientEmail = {
  messageId: '<multi@mail.example.com>',
  from: {
    value: [{ address: 'sender@newsletter.com', name: 'Multi Sender' }],
    text: 'Multi Sender <sender@newsletter.com>',
  },
  to: {
    value: [
      { address: 'other@example.com', name: '' },
      { address: 'inbox@reader.example.com', name: '' },
    ],
    text: 'other@example.com, inbox@reader.example.com',
  },
  subject: 'Multi-recipient Newsletter',
  date: new Date('2026-03-08T10:00:00Z'),
  html: '<p>Content for multiple recipients with enough words to be a reasonable newsletter article.</p>',
  text: 'Content for multiple recipients with enough words to be a reasonable newsletter article.',
  headers: new Map([['message-id', '<multi@mail.example.com>']]),
};
