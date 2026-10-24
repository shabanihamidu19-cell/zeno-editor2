import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/editor/editor.page').then(m => m.EditorPage)
  },
  { path: '**', redirectTo: '' }
];
