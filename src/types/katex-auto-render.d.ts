declare module 'katex/contrib/auto-render' {
  interface Delimiter {
    left: string;
    right: string;
    display: boolean;
  }

  interface AutoRenderOptions {
    delimiters?: Delimiter[];
    ignoredTags?: string[];
    ignoredClasses?: string[];
    errorCallback?: (msg: string, err: Error) => void;
    throwOnError?: boolean;
    /** Controls output format. 'html' omits MathML, preventing text-selection duplication. */
    output?: 'html' | 'mathml' | 'htmlAndMathml';
  }

  export default function renderMathInElement(
    element: HTMLElement,
    options?: AutoRenderOptions,
  ): void;
}
