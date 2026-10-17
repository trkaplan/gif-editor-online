import './styles.css';
import { Editor } from './app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app');

const editor = new Editor(root);
void editor.start();

if (import.meta.env.DEV) {
  (window as unknown as { __editor: Editor }).__editor = editor;
}
