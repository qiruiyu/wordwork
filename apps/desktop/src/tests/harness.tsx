/**
 * Minimal React 18 render harness.
 *
 * `@testing-library/react` is not a dependency of this workspace, so the component
 * tests drive `react-dom/client` directly. `act` comes from `react` (18.3 exports it);
 * `react-dom/test-utils` still works but is deprecated, and pulling it in just for
 * this would add a dependency for no gain.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactElement } from 'react';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  /** Re-render the same root, keeping component state — this is what a revision bump does. */
  render: (element: ReactElement) => Promise<void>;
  /** Let every pending promise chain and effect settle. */
  settle: () => Promise<void>;
  buttons: (label: string) => HTMLButtonElement[];
  click: (button: HTMLElement) => Promise<void>;
  text: () => string;
  unmount: () => void;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const settle = async () => {
    // Two macrotask boundaries. One is enough for a single awaited promise, but the
    // save path chains api -> dialog -> probe -> write, and a chained chain needs the
    // microtask queue drained more than once.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const render = async (next: ReactElement) => {
    await act(async () => {
      root.render(next);
    });
    await settle();
  };

  const mounted: Mounted = {
    container,
    render,
    settle,
    buttons: (label) =>
      Array.from(container.querySelectorAll('button')).filter((node) =>
        (node.textContent ?? '').includes(label),
      ),
    click: async (button) => {
      await act(async () => {
        button.click();
      });
      await settle();
    },
    text: () => container.textContent ?? '',
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };

  await render(element);
  return mounted;
}
