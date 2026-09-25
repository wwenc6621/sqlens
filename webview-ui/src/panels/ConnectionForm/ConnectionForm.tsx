import React, { useState, useEffect, useCallback } from 'react';
import { postMessage, onMessage } from '../../hooks/useVsCode';
import Icon from '../../components/Icon';
import DbTypeIcon, { dbLabelColor } from '../../components/DbTypeIcon';
import { t } from '../../i18n';
import './ConnectionForm.css';

interface SSHConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey' | 'agent';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

interface SSLConfig {
  mode: string;
  caPath?: string;
  certPath?: string;
  keyPath?: string;
}

interface FormData {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  filepath?: string;
  ssl: SSLConfig;
  ssh: SSHConfig;
  options: Record<string, unknown>;
  group: string;
  tags: string[];
  color: string;
  createdAt: number;
  updatedAt: number;
}

const DB_TYPES = [
  { value: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { value: 'mariadb', label: 'MariaDB', defaultPort: 3306 },
  { value: 'postgresql', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'redis', label: 'Redis', defaultPort: 6379 },
  { value: 'sqlite', label: 'SQLite', defaultPort: 0 },
  { value: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
];

const SSL_MODES = [
  { value: 'disabled', label: t('Disabled') },
  { value: 'preferred', label: t('Preferred') },
  { value: 'required', label: t('Required') },
  { value: 'verify-ca', label: t('Verify CA') },
  { value: 'verify-full', label: t('Verify Full') },
];

const COLORS = [
  { value: '', label: t('None') },
  { value: '#e74c3c', label: t('Red') },
  { value: '#e67e22', label: t('Orange') },
  { value: '#f1c40f', label: t('Yellow') },
  { value: '#2ecc71', label: t('Green') },
  { value: '#3498db', label: t('Blue') },
  { value: '#9b59b6', label: t('Purple') },
];

const REDIS_MODES = [
  { value: 'standalone', label: t('Standalone') },
  { value: 'cluster', label: t('Cluster') },
  { value: 'sentinel', label: t('Sentinel') },
];

const defaultForm: FormData = {
  id: '',
  name: '',
  type: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  username: 'root',
  password: '',
  database: '',
  ssl: { mode: 'preferred' },
  ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password', privateKeyPath: '~/.ssh/id_rsa' },
  options: {},
  group: '',
  tags: [],
  color: '',
  createdAt: 0,
  updatedAt: 0,
};

interface SSHConfigHost {
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Wrap a label's text with a red required marker. */
const req = (label: string) => (
  <>
    {label}<span className="required-mark">*</span>
  </>
);

export default function ConnectionForm() {
  const [form, setForm] = useState<FormData>(defaultForm);
  const [activeTab, setActiveTab] = useState<'general' | 'ssh' | 'ssl' | 'advanced'>('general');
  const [testing, setTesting] = useState(false);
  const [sshHosts, setSSHHosts] = useState<SSHConfigHost[]>([]);
  const [selectedSSHHost, setSelectedSSHHost] = useState<string>('');

  useEffect(() => {
    // Signal readiness to extension
    postMessage({ type: 'ready' });

    const unsub = onMessage((msg: any) => {
      if (msg.type === 'connectionConfig') {
        setForm({ ...defaultForm, ...msg.data, password: msg.data.password || '' });
      } else if (msg.type === 'sshHosts') {
        setSSHHosts(msg.data || []);
      }
    });

    return unsub;
  }, []);

  const updateField = useCallback((field: string, value: unknown) => {
    setForm(prev => ({ ...prev, [field]: value }));
  }, []);

  const updateOption = useCallback((field: string, value: unknown) => {
    setForm(prev => ({ ...prev, options: { ...prev.options, [field]: value } }));
  }, []);

  const updateSSH = useCallback((field: string, value: unknown) => {
    setForm(prev => ({ ...prev, ssh: { ...prev.ssh, [field]: value } }));
  }, []);

  useEffect(() => {
    if (form.ssh.enabled && form.ssh.host && sshHosts.length > 0) {
      const matched = sshHosts.find(h => h.host === form.ssh.host || h.hostName === form.ssh.host);
      if (matched) {
        setSelectedSSHHost(matched.host);
      }
    }
  }, [form.ssh.host, sshHosts, form.ssh.enabled]);

  const handleSSHHostChange = useCallback((hostAlias: string) => {
    setSelectedSSHHost(hostAlias);
    if (!hostAlias) return;

    const matched = sshHosts.find(h => h.host === hostAlias);
    if (matched) {
      updateSSH('host', matched.hostName || matched.host);
      if (matched.port) {
        updateSSH('port', matched.port);
      } else {
        updateSSH('port', 22);
      }
      if (matched.user) {
        updateSSH('username', matched.user);
      }
      if (matched.identityFile) {
        updateSSH('authMethod', 'privateKey');
        updateSSH('privateKeyPath', matched.identityFile);
      }
    }
  }, [sshHosts, updateSSH]);

  const updateSSL = useCallback((field: string, value: unknown) => {
    setForm(prev => ({ ...prev, ssl: { ...prev.ssl, [field]: value } }));
  }, []);

  const handleTypeChange = useCallback((type: string) => {
    const dbType = DB_TYPES.find(t => t.value === type);
    setForm(prev => ({
      ...prev,
      type,
      // Only swap the port if the user hasn't changed it from the previous
      // type's default (otherwise keep their custom value).
      port: DB_TYPES.some(d => d.value === prev.type && d.defaultPort === prev.port)
        ? dbType?.defaultPort ?? prev.port
        : prev.port,
    }));
  }, []);

  const handleTest = useCallback(() => {
    setTesting(true);
    postMessage({ type: 'testConnection', data: form });
    setTimeout(() => setTesting(false), 3000);
  }, [form]);

  const handleSave = useCallback(() => {
    postMessage({ type: 'saveConnection', data: form });
  }, [form]);

  const isSQLite = form.type === 'sqlite';
  const isRedis = form.type === 'redis';
  const redisMode = (form.options.redisMode as string) || 'standalone';
  const redisNodesText = ((form.options.redisNodes as string[]) || []).join('\n');

  return (
    <div className="connection-form">
      {/* Header */}
      <div className="form-header">
        <h2>{form.id ? t('Edit Connection') : t('New Connection')}</h2>
        <div className="form-header-actions">
          <button className="secondary" onClick={handleTest} disabled={testing}>
            {testing ? <><Icon name="clock" size={13} /> {t('Testing...')}</> : <><Icon name="plug" size={13} /> {t('Test')}</>}
          </button>
          <button className="primary" onClick={handleSave}>
            <Icon name="save" size={13} /> {t('Save')}
          </button>
        </div>
      </div>

      {/* Database type picker */}
      <div className="db-type-tabs">
        {DB_TYPES.map(dt => {
          const isActive = form.type === dt.value;
          return (
            <button
              key={dt.value}
              type="button"
              className={`db-type-tab${isActive ? ' active' : ''}`}
              onClick={() => handleTypeChange(dt.value)}
              title={dt.label}
              style={isActive ? { color: dbLabelColor(dt.value) } : undefined}
            >
              <DbTypeIcon type={dt.value} size={14} />
              <span>{dt.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="form-tabs">
        {(['general', 'ssh', 'ssl', 'advanced'] as const).map(tab => {
          const tabMeta = {
            general: { icon: 'zap' as const, label: t('General') },
            ssh: { icon: 'lock' as const, label: t('SSH') },
            ssl: { icon: 'shield' as const, label: t('SSL') },
            advanced: { icon: 'gear' as const, label: t('Advanced') },
          }[tab];
          return (
            <button
              key={tab}
              className={`tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <Icon name={tabMeta.icon} size={13} /> {tabMeta.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="form-content">
        {activeTab === 'general' && (
          <div className="form-grid">
            <div className="form-row">
              <div className="form-field">
                <label>{req(t('Connection Name'))}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={t('My Database')}
                  autoFocus
                />
              </div>
            </div>

            {isSQLite ? (
              <div className="form-field">
                <label>{req(t('Database File'))}</label>
                <input
                  type="text"
                  value={form.filepath || form.database || ''}
                  onChange={e => {
                    updateField('filepath', e.target.value);
                    updateField('database', e.target.value);
                  }}
                  placeholder="/path/to/database.sqlite"
                />
              </div>
            ) : isRedis ? (
              <>
                <div className="form-field">
                  <label>{t('Redis Mode')}</label>
                  <div className="radio-group">
                    {REDIS_MODES.map(m => (
                      <label key={m.value} className={`radio-pill${redisMode === m.value ? ' active' : ''}`}>
                        <input
                          type="radio"
                          name="redisMode"
                          value={m.value}
                          checked={redisMode === m.value}
                          onChange={() => updateOption('redisMode', m.value)}
                        />
                        <span>{m.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {redisMode === 'standalone' && (
                  <>
                    <div className="form-row">
                      <div className="form-field" style={{ flex: 2 }}>
                        <label>{req(t('Host'))}</label>
                        <input
                          type="text"
                          value={form.host}
                          onChange={e => updateField('host', e.target.value)}
                          placeholder="127.0.0.1"
                        />
                      </div>
                      <div className="form-field" style={{ maxWidth: 120 }}>
                        <label>{req(t('Port'))}</label>
                        <input
                          type="number"
                          value={form.port}
                          onChange={e => updateField('port', parseInt(e.target.value) || 0)}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-field">
                        <label>{req(t('Username'))}</label>
                        <input
                          type="text"
                          value={form.username}
                          onChange={e => updateField('username', e.target.value)}
                          placeholder="default"
                        />
                      </div>
                      <div className="form-field">
                        <label>{t('Password')}</label>
                        <input
                          type="password"
                          value={form.password}
                          onChange={e => updateField('password', e.target.value)}
                          placeholder="••••••••"
                        />
                      </div>
                    </div>
                    <div className="form-field">
                      <label>{t('DB Index')}</label>
                      <input
                        type="text"
                        value={form.database}
                        onChange={e => updateField('database', e.target.value)}
                        placeholder="0"
                      />
                    </div>
                  </>
                )}

                {redisMode === 'cluster' && (
                  <>
                    <div className="form-field">
                      <label>{req(t('Cluster Nodes (one host:port per line)'))}</label>
                      <textarea
                        className="redis-nodes"
                        rows={4}
                        value={redisNodesText}
                        onChange={e => updateOption('redisNodes', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
                        placeholder="127.0.0.1:7000&#10;127.0.0.1:7001"
                      />
                    </div>
                    <div className="form-row">
                      <div className="form-field">
                        <label>{req(t('Username'))}</label>
                        <input
                          type="text"
                          value={form.username}
                          onChange={e => updateField('username', e.target.value)}
                          placeholder="default"
                        />
                      </div>
                      <div className="form-field">
                        <label>{t('Password')}</label>
                        <input
                          type="password"
                          value={form.password}
                          onChange={e => updateField('password', e.target.value)}
                          placeholder="••••••••"
                        />
                      </div>
                    </div>
                  </>
                )}

                {redisMode === 'sentinel' && (
                  <>
                    <div className="form-field">
                      <label>{req(t('Master Name'))}</label>
                      <input
                        type="text"
                        value={(form.options.redisSentinelName as string) || ''}
                        onChange={e => updateOption('redisSentinelName', e.target.value)}
                        placeholder="mymaster"
                      />
                    </div>
                    <div className="form-field">
                      <label>{req(t('Sentinel Nodes (one host:port per line)'))}</label>
                      <textarea
                        className="redis-nodes"
                        rows={4}
                        value={redisNodesText}
                        onChange={e => updateOption('redisNodes', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
                        placeholder="127.0.0.1:26379"
                      />
                    </div>
                    <div className="form-row">
                      <div className="form-field">
                        <label>{req(t('Username'))}</label>
                        <input
                          type="text"
                          value={form.username}
                          onChange={e => updateField('username', e.target.value)}
                          placeholder="default"
                        />
                      </div>
                      <div className="form-field">
                        <label>{t('Password')}</label>
                        <input
                          type="password"
                          value={form.password}
                          onChange={e => updateField('password', e.target.value)}
                          placeholder="••••••••"
                        />
                      </div>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="form-row">
                  <div className="form-field" style={{ flex: 2 }}>
                    <label>{req(t('Host'))}</label>
                    <input
                      type="text"
                      value={form.host}
                      onChange={e => updateField('host', e.target.value)}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="form-field" style={{ maxWidth: 120 }}>
                    <label>{req(t('Port'))}</label>
                    <input
                      type="number"
                      value={form.port}
                      onChange={e => updateField('port', parseInt(e.target.value) || 0)}
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div className="form-field">
                    <label>{req(t('Username'))}</label>
                    <input
                      type="text"
                      value={form.username}
                      onChange={e => updateField('username', e.target.value)}
                      placeholder="root"
                    />
                  </div>
                  <div className="form-field">
                    <label>{t('Password')}</label>
                    <input
                      type="password"
                      value={form.password}
                      onChange={e => updateField('password', e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                </div>

                <div className="form-field">
                  <label>{t('Database')}</label>
                  <input
                    type="text"
                    value={form.database}
                    onChange={e => updateField('database', e.target.value)}
                    placeholder={form.type === 'postgresql' ? 'postgres' : 'my_database'}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'ssh' && (
          <div className="form-grid">
            <label className="checkbox-wrapper">
              <input
                type="checkbox"
                checked={form.ssh.enabled}
                onChange={e => updateSSH('enabled', e.target.checked)}
              />
              <span>{t('Use SSH Tunnel')}</span>
            </label>

            {form.ssh.enabled && (
              <>
                {sshHosts.length > 0 && (
                  <div className="form-field">
                    <label>{t('Import from SSH Config (~/.ssh/config)')}</label>
                    <select
                      value={selectedSSHHost}
                      onChange={e => handleSSHHostChange(e.target.value)}
                    >
                      <option value="">{t('-- Manual Configuration --')}</option>
                      {sshHosts.map(h => (
                        <option key={h.host} value={h.host}>
                          {h.host} {h.hostName ? `(${h.hostName})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="form-row">
                  <div className="form-field" style={{ flex: 2 }}>
                    <label>{req(t('SSH Host'))}</label>
                    <input
                      type="text"
                      value={form.ssh.host}
                      onChange={e => updateSSH('host', e.target.value)}
                      placeholder="ssh.example.com"
                    />
                  </div>
                  <div className="form-field" style={{ maxWidth: 120 }}>
                    <label>{t('SSH Port')}</label>
                    <input
                      type="number"
                      value={form.ssh.port}
                      onChange={e => updateSSH('port', parseInt(e.target.value) || 22)}
                    />
                  </div>
                </div>

                <div className="form-field">
                  <label>{req(t('SSH Username'))}</label>
                  <input
                    type="text"
                    value={form.ssh.username}
                    onChange={e => updateSSH('username', e.target.value)}
                    placeholder="ubuntu"
                  />
                </div>

                <div className="form-field">
                  <label>{t('Auth Method')}</label>
                  <select
                    value={form.ssh.authMethod}
                    onChange={e => updateSSH('authMethod', e.target.value)}
                  >
                    <option value="password">{t('Password')}</option>
                    <option value="privateKey">{t('Private Key')}</option>
                    <option value="agent">{t('SSH Agent')}</option>
                  </select>
                </div>

                {form.ssh.authMethod === 'password' && (
                  <div className="form-field">
                    <label>{req(t('SSH Password'))}</label>
                    <input
                      type="password"
                      value={form.ssh.password || ''}
                      onChange={e => updateSSH('password', e.target.value)}
                      placeholder="••••••••"
                    />
                  </div>
                )}

                {form.ssh.authMethod === 'privateKey' && (
                  <>
                    <div className="form-field">
                      <label>{t('Private Key Path')}</label>
                      <input
                        type="text"
                        value={form.ssh.privateKeyPath || ''}
                        onChange={e => updateSSH('privateKeyPath', e.target.value)}
                        placeholder="~/.ssh/id_rsa"
                      />
                    </div>
                    <div className="form-field">
                      <label>{t('Passphrase (optional)')}</label>
                      <input
                        type="password"
                        value={form.ssh.passphrase || ''}
                        onChange={e => updateSSH('passphrase', e.target.value)}
                        placeholder="••••••••"
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'ssl' && (
          <div className="form-grid">
            <div className="form-field">
              <label>{t('SSL Mode')}</label>
              <select value={form.ssl.mode} onChange={e => updateSSL('mode', e.target.value)}>
                {SSL_MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>

            {form.ssl.mode !== 'disabled' && form.ssl.mode !== 'preferred' && (
              <>
                <div className="form-field">
                  <label>{t('CA Certificate')}</label>
                  <input
                    type="text"
                    value={form.ssl.caPath || ''}
                    onChange={e => updateSSL('caPath', e.target.value)}
                    placeholder="/path/to/ca.pem"
                  />
                </div>
                <div className="form-field">
                  <label>{t('Client Certificate')}</label>
                  <input
                    type="text"
                    value={form.ssl.certPath || ''}
                    onChange={e => updateSSL('certPath', e.target.value)}
                    placeholder="/path/to/client-cert.pem"
                  />
                </div>
                <div className="form-field">
                  <label>{t('Client Key')}</label>
                  <input
                    type="text"
                    value={form.ssl.keyPath || ''}
                    onChange={e => updateSSL('keyPath', e.target.value)}
                    placeholder="/path/to/client-key.pem"
                  />
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="form-grid">
            <div className="form-field">
              <label>{t('Group')}</label>
              <input
                type="text"
                value={form.group || ''}
                onChange={e => updateField('group', e.target.value)}
                placeholder={t('Production, Staging, Local...')}
              />
            </div>

            <div className="form-field">
              <label>{t('Color Label')}</label>
              <select value={form.color || ''} onChange={e => updateField('color', e.target.value)}>
                {COLORS.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label>{t('Tags (comma-separated)')}</label>
              <input
                type="text"
                value={form.tags.join(', ')}
                onChange={e => updateField('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                placeholder="backend, shared, read-only"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
