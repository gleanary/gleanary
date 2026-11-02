/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Field } from '@/components/context-panel/field';
import { TextBlock } from '@/components/context-panel/text-block';
import { TagList } from '@/components/context-panel/tag-list';

afterEach(cleanup);

describe('Field', () => {
  function renderField(value: React.ReactNode | null) {
    render(
      <dl>
        <Field label="Author" value={value} />
      </dl>,
    );
    return screen.getByRole('definition');
  }

  it('renders the label and the value', () => {
    const value = renderField('Jane Doe');
    expect(screen.getByRole('term').textContent).toContain('Author');
    expect(value.textContent).toContain('Jane Doe');
  });

  it('renders an em-dash for a null value', () => {
    expect(renderField(null).textContent).toContain('—');
  });

  it('renders an em-dash for an empty string', () => {
    expect(renderField('').textContent).toContain('—');
  });

  it('renders 0 as a value, not as empty', () => {
    expect(renderField(0).textContent).toContain('0');
  });
});

describe('TextBlock', () => {
  it('renders the text with line breaks preserved', () => {
    render(<TextBlock value={'First line.\nSecond line.'} />);
    const block = screen.getByTestId('panel-text-block');
    expect(block.textContent).toBe('First line.\nSecond line.');
    expect(block.className).toContain('whitespace-pre-line');
  });

  it('renders HTML in the value as plain text, never as markup', () => {
    render(<TextBlock value={'<img src=x onerror="alert(1)"><b>bold</b>'} />);
    const block = screen.getByTestId('panel-text-block');
    expect(block.querySelector('img, b')).toBeNull();
    expect(block.textContent).toContain('<b>bold</b>');
  });

  it('renders the empty state when the value is null', () => {
    render(<TextBlock value={null} emptyState={<span>nothing yet</span>} />);
    expect(screen.getByText('nothing yet')).toBeTruthy();
    expect(screen.queryByTestId('panel-text-block')).toBeNull();
  });

  it('renders the empty state when the value is an empty string', () => {
    render(<TextBlock value="" emptyState={<span>nothing yet</span>} />);
    expect(screen.getByText('nothing yet')).toBeTruthy();
    expect(screen.queryByTestId('panel-text-block')).toBeNull();
  });

  it('renders nothing when empty and there is no empty state', () => {
    const { container } = render(<TextBlock value={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('TagList', () => {
  it('renders one item per tag', () => {
    render(<TagList tags={['ai', 'Machine Learning']} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['ai', 'Machine Learning']);
  });

  it('renders the empty state when there are no tags', () => {
    render(<TagList tags={[]} emptyState={<span>no tags</span>} />);
    expect(screen.getByText('no tags')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders nothing when empty and there is no empty state', () => {
    const { container } = render(<TagList tags={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
