import React, { useState } from 'react';
import { ApiClient } from '../app/apiClient';
import { Sesion } from '../app/types';
import { btnPrimario, ErrorBanner } from '../app/ui';

/** Login: email + password -> sesion (token + empresas del usuario). */
export function LoginPage(props: { api: ApiClient; onLogin: (s: Sesion) => void }): React.ReactElement {
  const [email, setEmail] = useState('demo@empresa.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const entrar = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setOcupado(true);
    setError(null);
    try {
      props.onLogin(await props.api.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de acceso');
    } finally {
      setOcupado(false);
    }
  };

  const input: React.CSSProperties = { display: 'block', width: '100%', padding: 8, margin: '6px 0 14px', borderRadius: 6, border: '1px solid #ccd', boxSizing: 'border-box' };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#16243a', fontFamily: 'system-ui, sans-serif' }}>
      <form onSubmit={(e) => void entrar(e)} style={{ background: '#fff', padding: 28, borderRadius: 10, width: 340 }}>
        <h1 style={{ fontSize: 20, marginTop: 0 }}>Conta API</h1>
        {error && <ErrorBanner mensaje={error} />}
        <label style={{ fontSize: 13 }}>
          Email
          <input style={input} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label style={{ fontSize: 13 }}>
          Contrasena
          <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <button style={{ ...btnPrimario, width: '100%', padding: 10 }} disabled={ocupado}>
          {ocupado ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
