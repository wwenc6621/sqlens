import * as assert from 'assert';
import { suite, test } from 'node:test';
import { DBeaverParser } from '../src/core/connection/import/dbeaverParser';
import { DataGripParser } from '../src/core/connection/import/dataGripParser';
import { EnvParser } from '../src/core/connection/import/envParser';
import { NavicatParser } from '../src/core/connection/import/navicatParser';
import { SpringConfigParser } from '../src/core/connection/import/springConfigParser';
import { TablePlusParser } from '../src/core/connection/import/tablePlusParser';
import { GridParser } from '../src/core/connection/import/gridParser';
import { JsonParser } from '../src/core/connection/import/jsonParser';
import { formatLabel, parseConnections } from '../src/core/connection/import';
import { UriParser } from '../src/core/connection/import/uriParser';
import { buildConnectionUri, schemeToType } from '../src/core/connection/import/uriUtils';
import { DatabaseType, SSLMode } from '../src/core/types';

suite('Connection Import Pipeline', () => {
  suite('sniffer', () => {
    test('routes sqlens payload to json parser', () => {
      const text = JSON.stringify({
        version: 1, source: 'sqlens', connections: [
          { name: 'a', type: 'mysql', host: 'h', port: 3306, username: 'u' },
        ],
      });
      const r = parseConnections(text);
      assert.strictEqual(r.format, 'sqlens-json');
      assert.strictEqual(r.connections.length, 1);
      assert.strictEqual(r.connections[0].draft.type, DatabaseType.MySQL);
    });

    test('routes bare json array', () => {
      const r = parseConnections('[{"name":"a","type":"redis","host":"127.0.0.1","port":6379}]');
      assert.strictEqual(r.format, 'json-array');
      assert.strictEqual(r.connections.length, 1);
    });

    test('routes uri lines', () => {
      const r = parseConnections('postgres://user:pw@db.example.com:5432/orders');
      assert.strictEqual(r.format, 'connection-uri');
      assert.strictEqual(r.connections[0].draft.type, DatabaseType.PostgreSQL);
    });

    test('routes tsv grid', () => {
      const r = parseConnections('name\thost\tport\ttype\nprod\t10.0.0.1\t3306\tmysql');
      assert.strictEqual(r.format, 'tsv');
      assert.strictEqual(r.connections[0].draft.name, 'prod');
    });

    test('routes dotenv', () => {
      const r = parseConnections('DATABASE_URL=mysql://root:pw@localhost:3306/shop\nAPP_ENV=prod');
      assert.strictEqual(r.format, 'dotenv');
      assert.strictEqual(r.connections[0].draft.database, 'shop');
    });

    test('reports error for unrecognized text', () => {
      const r = parseConnections('hello world, nothing here');
      assert.strictEqual(r.connections.length, 0);
      assert.ok(r.error);
    });

    test('formatLabel', () => {
      assert.strictEqual(formatLabel('dotenv'), '.env');
    });
  });

  suite('uriParser', () => {
    const parser = new UriParser();

    test('mysql with password and sslmode', () => {
      const out = parser.parse('mysql://root:se%2Fcret@db1.example.com:3307/shop?sslmode=required');
      assert.strictEqual(out.length, 1);
      const d = out[0].draft;
      assert.strictEqual(d.type, DatabaseType.MySQL);
      assert.strictEqual(d.host, 'db1.example.com');
      assert.strictEqual(d.port, 3307);
      assert.strictEqual(d.username, 'root');
      assert.strictEqual(d.password, 'se/cret');
      assert.strictEqual(d.database, 'shop');
      assert.strictEqual(d.ssl.mode, SSLMode.Required);
    });

    test('redis over tls (rediss) implies ssl required', () => {
      const d = parser.parse('rediss://default:p@10.0.0.9:6380')[0].draft;
      assert.strictEqual(d.type, DatabaseType.Redis);
      assert.strictEqual(d.ssl.mode, SSLMode.Required);
    });

    test('mongodb+srv marks srv option', () => {
      const d = parser.parse('mongodb+srv://alice:p@cluster0.abc.mongodb.net/mydb')[0].draft;
      assert.strictEqual(d.type, DatabaseType.MongoDB);
      assert.strictEqual(d.options.srv, true);
    });

    test('sqlite path form', () => {
      const d = parser.parse('sqlite:///Users/me/data/app.sqlite')[0].draft;
      assert.strictEqual(d.type, DatabaseType.SQLite);
      assert.strictEqual(d.filepath, '/Users/me/data/app.sqlite');
    });

    test('ssh extension params', () => {
      const d = parser.parse('mysql://h.local/app?ssh=true&ssh_host=bastion&ssh_user=ops&ssh_port=2222')[0].draft;
      assert.strictEqual(d.ssh.enabled, true);
      assert.strictEqual(d.ssh.host, 'bastion');
      assert.strictEqual(d.ssh.username, 'ops');
      assert.strictEqual(d.ssh.port, 2222);
    });

    test('multiple uris, comments and blank lines', () => {
      const out = parser.parse('# prod\n\nmysql://a@h1/db1\nredis://h2\n');
      assert.strictEqual(out.length, 2);
    });

    test('password containing slash and encoded chars', () => {
      const d = parser.parse('postgres://u:p%40ss%2Fw@host/db')[0].draft;
      assert.strictEqual(d.password, 'p@ss/w');
    });

    test('probe rejects unknown schemes', () => {
      assert.strictEqual(parser.probe('ftp://host/file'), 0);
    });
  });

  suite('gridParser', () => {
    const parser = new GridParser();

    test('tsv with english headers', () => {
      const out = parser.parse('name\thost\tport\tusername\tpassword\tdatabase\ttype\nprod\t10.0.0.1\t3306\troot\tpw\tshop\tmysql\nstage\t10.0.0.2\t5432\tpostgres\tpw2\tshop2\tpostgresql');
      assert.strictEqual(out.length, 2);
      assert.strictEqual(out[0].draft.name, 'prod');
      assert.strictEqual(out[0].draft.port, 3306);
      assert.strictEqual(out[0].draft.type, DatabaseType.MySQL);
      assert.strictEqual(out[1].draft.type, DatabaseType.PostgreSQL);
      assert.strictEqual(out[1].draft.password, 'pw2');
    });

    test('csv with chinese headers and quoted values', () => {
      const out = parser.parse('名称,主机,端口,用户名,密码,数据库\n"生产,库","10.0.0.1",3306,root,pw,shop');
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].draft.name, '生产,库');
      assert.strictEqual(out[0].draft.host, '10.0.0.1');
      assert.strictEqual(out[0].draft.type, DatabaseType.MySQL); // inferred from port
    });

    test('group and tags columns', () => {
      const out = parser.parse('name\thost\tport\tgroup\ttags\nx\th1\t3306\tprod\t;a;b;\n')[0];
      assert.strictEqual(out.draft.group, 'prod');
      assert.deepStrictEqual(out.draft.tags, ['a', 'b']);
    });

    test('no recognizable header → empty result (no silent column guessing)', () => {
      const out = parser.parse('a,b,c\n1,2,3');
      assert.strictEqual(out.length, 0);
    });

    test('ssh columns enable ssh', () => {
      const d = parser.parse('name\thost\tport\tssh_host\tssh_user\nx\th1\t3306\tbastion\tops')[0].draft;
      assert.strictEqual(d.ssh.enabled, true);
      assert.strictEqual(d.ssh.host, 'bastion');
    });
  });

  suite('envParser', () => {
    const parser = new EnvParser();

    test('DATABASE_URL', () => {
      const d = parser.parse('DATABASE_URL="postgresql://u:p@db.local:5432/analytics"\n')[0].draft;
      assert.strictEqual(d.type, DatabaseType.PostgreSQL);
      assert.strictEqual(d.database, 'analytics');
    });

    test('split MYSQL_* keys', () => {
      const d = parser.parse('MYSQL_HOST=10.1.1.1\nMYSQL_PORT=3307\nMYSQL_USER=admin\nMYSQL_PASSWORD=secret\nMYSQL_DB=crm')[0].draft;
      assert.strictEqual(d.type, DatabaseType.MySQL);
      assert.strictEqual(d.host, '10.1.1.1');
      assert.strictEqual(d.port, 3307);
      assert.strictEqual(d.username, 'admin');
      assert.strictEqual(d.password, 'secret');
      assert.strictEqual(d.database, 'crm');
    });

    test('comments, export prefix and quotes', () => {
      const d = parser.parse('# comment\nexport REDIS_HOST="cache.local"\n')[0].draft;
      assert.strictEqual(d.host, 'cache.local');
    });
  });

  suite('jsonParser regression (extractConnections behavior)', () => {
    const parser = new JsonParser();

    test('filters entries missing name/type or bad type', () => {
      const out = parser.parse(JSON.stringify({
        connections: [
          { name: 'ok', type: 'mysql' },
          { type: 'mysql' },                 // no name
          { name: 'x' },                     // no type
          { name: 'bad', type: 'oracle' },   // unknown type
          'not-an-object',
        ],
      }));
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].draft.name, 'ok');
    });
  });

  suite('dbeaverParser', () => {
    const parser = new DBeaverParser();

    const dbeaverJson = JSON.stringify({
      folders: {},
      'data-sources': {
        'abc-1': {
          provider: 'postgresql',
          name: 'Local PG',
          configuration: { host: 'localhost', port: '5432', database: 'app', user: 'dev' },
        },
        'abc-2': {
          provider: 'mysql',
          name: 'From JDBC URL',
          configuration: { url: 'jdbc:mysql://db.corp.net:3307/shop' },
        },
        'abc-3': {
          provider: 'oracle',
          name: 'unsupported provider',
          configuration: { host: 'h' },
        },
      },
    });

    test('parses providers and skips unsupported ones', () => {
      const out = parser.parse(dbeaverJson);
      assert.strictEqual(out.length, 2);
      assert.strictEqual(out[0].draft.type, DatabaseType.PostgreSQL);
      assert.strictEqual(out[0].draft.port, 5432);
      assert.strictEqual(out[0].draft.username, 'dev');
    });

    test('falls back to jdbc url host/port/db', () => {
      const out = parser.parse(dbeaverJson);
      assert.strictEqual(out[1].draft.host, 'db.corp.net');
      assert.strictEqual(out[1].draft.port, 3307);
      assert.strictEqual(out[1].draft.database, 'shop');
    });

    test('always records missing-password issue', () => {
      const out = parser.parse(dbeaverJson);
      assert.ok(out[0].issues.some(i => i.message.includes('password')));
    });

    test('probe rejects other json', () => {
      assert.strictEqual(parser.probe('{"connections":[]}'), 0);
      assert.strictEqual(parser.probe(dbeaverJson), 1);
    });
  });

  suite('dataGripParser', () => {
    const parser = new DataGripParser();

    // Real "Copy Settings" output from DataGrip (password is never included).
    const dataGripSample = `#DataSourceSettings#
#LocalDataSource: jsaap1570
#BEGIN#
<data-source source="LOCAL" name="jsaap1570" uuid="ef91cf5b-1b18-4143-a2bc-4eb28e57fc3b"><database-info product="MySQL" version="8.0.36" jdbc-version="4.2" driver-name="MySQL Connector/J" driver-version="mysql-connector-java-8.0.13" dbms="MYSQL" exact-version="8.0.36"><extra-name-characters>#@</extra-name-characters><identifier-quote-string>\`</identifier-quote-string><jdbc-catalog-is-schema>true</jdbc-catalog-is-schema></database-info><case-sensitivity plain-identifiers="exact" quoted-identifiers="exact"/><driver-ref>9bb40c7a-ea05-48d4-9cf7-91e34ada4820</driver-ref><synchronize>true</synchronize><jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver><jdbc-url>jdbc:mysql://10.19.32.107:3306/jsaap1570?autoReconnect=true&amp;useUnicode=true&amp;characterEncoding=utf8&amp;useSSL=false&amp;serverTimezone=Asia/Shanghai&amp;allowPublicKeyRetrieval=true&amp;zeroDateTimeBehavior=convertToNull&amp;allowMultiQueries=true</jdbc-url><jdbc-additional-properties><property name="com.intellij.clouds.kubernetes.db.host.port"/><property name="com.intellij.clouds.kubernetes.db.enabled" value="false"/><property name="com.intellij.clouds.kubernetes.db.container.port"/></jdbc-additional-properties><secret-storage>master_key</secret-storage><user-name>root</user-name><schema-mapping><introspection-scope><node kind="schema"><name qname="jsaap1570"/><name qname="qcraft_audit_test"/></node></introspection-scope></schema-mapping><load-sources>user_and_system_sources</load-sources><working-dir>$ProjectFileDir$</working-dir></data-source>
#END#`;

    test('parses the real DataGrip Copy Settings output', () => {
      const out = parser.parse(dataGripSample);
      assert.strictEqual(out.length, 1);
      const d = out[0].draft;
      assert.strictEqual(d.name, 'jsaap1570');
      assert.strictEqual(d.type, DatabaseType.MySQL);
      assert.strictEqual(d.host, '10.19.32.107');
      assert.strictEqual(d.port, 3306);
      assert.strictEqual(d.database, 'jsaap1570');
      assert.strictEqual(d.username, 'root');
    });

    test('useSSL=false maps to ssl disabled; other params land in options', () => {
      const d = parser.parse(dataGripSample)[0].draft;
      assert.strictEqual(d.ssl.mode, SSLMode.Disabled);
      assert.strictEqual(d.options.serverTimezone, 'Asia/Shanghai');
      assert.strictEqual(d.options.allowMultiQueries, 'true');
    });

    test('records the missing-password issue', () => {
      const out = parser.parse(dataGripSample)[0];
      assert.ok(out.issues.some(i => i.message.toLowerCase().includes('password')));
    });

    test('probe and unsupported products', () => {
      assert.strictEqual(parser.probe(dataGripSample), 1);
      assert.strictEqual(parser.probe('mysql://h/db'), 0);
      const oracle = dataGripSample.replace('product="MySQL"', 'product="Oracle"').replace('dbms="MYSQL"', 'dbms="ORACLE"');
      assert.strictEqual(parser.parse(oracle).length, 0);
    });
  });

  suite('navicatParser', () => {
    const parser = new NavicatParser();

    test('legacy per-provider tags', () => {
      const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<NavicatConnection>
  <mysql ConnectionName="prod-mysql" Host="10.0.0.1" Port="3307" UserName="root" Database="shop" Password="encrypted-blob"/>
  <postgresql ConnectionName="prod-pg" Host="db.local" Port="5432" UserName="dev" Database="app"/>
</NavicatConnection>`;
      const out = parser.parse(ncx);
      assert.strictEqual(out.length, 2);
      assert.strictEqual(out[0].draft.name, 'prod-mysql');
      assert.strictEqual(out[0].draft.type, DatabaseType.MySQL);
      assert.strictEqual(out[0].draft.host, '10.0.0.1');
      assert.strictEqual(out[0].draft.port, 3307);
      assert.strictEqual(out[0].draft.username, 'root');
      assert.strictEqual(out[0].draft.database, 'shop');
      assert.strictEqual(out[1].draft.type, DatabaseType.PostgreSQL);
      // Encrypted password attribute must NOT be imported.
      assert.strictEqual(out[0].draft.password, undefined);
      assert.ok(out[0].issues.some(i => i.message.toLowerCase().includes('password')));
    });

    test('server/general style', () => {
      const ncx = `<NavicatConnection>
  <server><general ConnectionName="redis-main" ConnectionType="REDIS" Host="cache.local" Port="6380"/></server>
</NavicatConnection>`;
      const d = parser.parse(ncx)[0].draft;
      assert.strictEqual(d.type, DatabaseType.Redis);
      assert.strictEqual(d.host, 'cache.local');
      assert.strictEqual(d.port, 6380);
    });

    test('sqlite uses file path attribute', () => {
      const ncx = `<NavicatConnection><sqlite ConnectionName="local-db" DatabaseFilePath="/data/app.sqlite"/></NavicatConnection>`;
      const d = parser.parse(ncx)[0].draft;
      assert.strictEqual(d.type, DatabaseType.SQLite);
      assert.strictEqual(d.filepath, '/data/app.sqlite');
    });

    test('probe rejects non-navicat xml and encrypted blobs', () => {
      assert.strictEqual(parser.probe('<data-source name="x"/>'), 0);
      assert.strictEqual(parser.probe('U29tZUVuY3J5cHRlZEJsb2I='), 0);
    });
  });

  suite('tablePlusParser', () => {
    const parser = new TablePlusParser();

    const tablePlusJson = JSON.stringify({
      Connections: [
        {
          Name: 'orders-db',
          Database: 'postgresql',
          Host: 'pg.internal',
          Port: '5433',
          User: 'svc',
          DatabaseName: 'orders',
          SSL: true,
          SSHHost: 'bastion',
          SSHPort: '2222',
          SSHUser: 'ops',
        },
        { Name: 'cache', Database: 'redis', Host: '127.0.0.1', Port: 6379 },
      ],
    });

    test('parses the Connections array with alias keys', () => {
      const out = parser.parse(tablePlusJson);
      assert.strictEqual(out.length, 2);
      const d = out[0].draft;
      assert.strictEqual(d.name, 'orders-db');
      assert.strictEqual(d.type, DatabaseType.PostgreSQL);
      assert.strictEqual(d.host, 'pg.internal');
      assert.strictEqual(d.port, 5433);
      assert.strictEqual(d.username, 'svc');
      assert.strictEqual(d.database, 'orders');
      assert.strictEqual(d.ssl.mode, SSLMode.Required);
      assert.strictEqual(d.ssh.enabled, true);
      assert.strictEqual(d.ssh.host, 'bastion');
      assert.strictEqual(d.ssh.port, 2222);
      assert.strictEqual(out[1].draft.type, DatabaseType.Redis);
      assert.strictEqual(out[1].draft.password, undefined);
    });

    test('records the keychain-password issue', () => {
      const out = parser.parse(tablePlusJson);
      assert.ok(out[0].issues.some(i => i.message.toLowerCase().includes('keychain')));
    });

    test('accepts bare array form and rejects other json', () => {
      assert.strictEqual(parser.parse('[{"name":"a","database":"mysql","host":"h"}]').length, 1);
      assert.strictEqual(parser.probe('{"connections":[]}'), 0);
    });
  });

  suite('springConfigParser', () => {
    const parser = new SpringConfigParser();

    const yamlSample = `server:
  port: 8080
spring:
  datasource:
    url: jdbc:mysql://10.19.32.107:3306/jsaap1570?useSSL=false&serverTimezone=Asia/Shanghai
    username: root
    password: secret
  redis:
    host: cache.local
    port: 6380
    password: rpw`;

    const propertiesSample = `spring.datasource.url=jdbc:postgresql://pg.internal:5433/orders?sslmode=require
spring.datasource.username=svc
spring.datasource.password=pw
spring.data.redis.host=127.0.0.1
spring.data.redis.port=6379
logging.level.root=INFO`;

    test('parses Spring yaml datasource (jdbc url + credentials)', () => {
      const out = parser.parse(yamlSample);
      const ds = out.find(c => c.draft.type === DatabaseType.MySQL);
      assert.ok(ds, 'mysql datasource should be parsed');
      assert.strictEqual(ds.draft.host, '10.19.32.107');
      assert.strictEqual(ds.draft.port, 3306);
      assert.strictEqual(ds.draft.database, 'jsaap1570');
      assert.strictEqual(ds.draft.username, 'root');
      assert.strictEqual(ds.draft.password, 'secret');
      assert.strictEqual(ds.draft.ssl.mode, SSLMode.Disabled);
      assert.strictEqual((ds.draft.options as any).serverTimezone, 'Asia/Shanghai');
    });

    test('parses Spring yaml split keys (redis)', () => {
      const out = parser.parse(yamlSample);
      const redis = out.find(c => c.draft.type === DatabaseType.Redis);
      assert.ok(redis, 'redis should be parsed');
      assert.strictEqual(redis.draft.host, 'cache.local');
      assert.strictEqual(redis.draft.port, 6380);
      assert.strictEqual(redis.draft.password, 'rpw');
    });

    test('parses properties format', () => {
      const out = parser.parse(propertiesSample);
      const ds = out.find(c => c.draft.type === DatabaseType.PostgreSQL);
      assert.ok(ds, 'postgres datasource should be parsed');
      assert.strictEqual(ds.draft.host, 'pg.internal');
      assert.strictEqual(ds.draft.port, 5433);
      assert.strictEqual(ds.draft.database, 'orders');
      assert.strictEqual(ds.draft.username, 'svc');
      assert.strictEqual(ds.draft.password, 'pw');
      assert.strictEqual(ds.draft.ssl.mode, SSLMode.Required);
      const redis = out.find(c => c.draft.type === DatabaseType.Redis);
      assert.ok(redis, 'redis should be parsed');
      assert.strictEqual(redis.draft.port, 6379);
    });

    test('probe and non-datasource configs', () => {
      assert.strictEqual(parser.probe(yamlSample), 1);
      assert.strictEqual(parser.probe(propertiesSample), 1);
      assert.strictEqual(parser.probe('server:\n  port: 8080\n'), 0);
      assert.strictEqual(parser.probe('MYSQL_HOST=10.0.0.1'), 0);
    });
  });

  suite('uriUtils export side', () => {
    test('schemeToType aliases', () => {
      assert.strictEqual(schemeToType('postgresql'), DatabaseType.PostgreSQL);
      assert.strictEqual(schemeToType('MSSQL'), DatabaseType.MSSQL);
      assert.strictEqual(schemeToType('clickhousedb'), DatabaseType.ClickHouse);
    });

    test('buildConnectionUri round trip (no password)', () => {
      const uri = buildConnectionUri({
        type: DatabaseType.PostgreSQL,
        host: 'db.example.com', port: 5432, username: 'alice',
        database: 'orders', ssl: { mode: SSLMode.Required },
      });
      assert.strictEqual(uri, 'postgres://alice@db.example.com/orders?sslmode=required');
      const back = new UriParser().parse(uri)[0].draft;
      assert.strictEqual(back.host, 'db.example.com');
      assert.strictEqual(back.ssl.mode, SSLMode.Required);
    });

    test('buildConnectionUri sqlite uses filepath', () => {
      assert.strictEqual(
        buildConnectionUri({ type: DatabaseType.SQLite, filepath: '/data/x.sqlite' }),
        'sqlite:///data/x.sqlite',
      );
    });
  });
});
