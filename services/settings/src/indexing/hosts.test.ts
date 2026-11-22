import { describe, expect, it } from 'vitest';
import { hostsOf } from './indexing-storage';

describe('hostsOf', () => {
  it('finds every host in URLs, host:port and connection strings', () => {
    expect(hostsOf('https://x.cloud.qdrant.io:6333/')).toEqual({
      scheme: 'https',
      hosts: ['x.cloud.qdrant.io'],
    });
    expect(hostsOf('in03-abc.zillizcloud.com:19530').hosts).toEqual(['in03-abc.zillizcloud.com']);
    expect(hostsOf('postgres://u:p@ss@db.example.com:5432/app?sslmode=require').hosts).toEqual([
      'db.example.com',
    ]);
    expect(hostsOf('mongodb://u:p@a.example.com:27017,b.example.com/db').hosts).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
    expect(hostsOf('mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true')).toEqual({
      scheme: 'mongodb+srv',
      hosts: ['cluster0.abc.mongodb.net'],
    });
    expect(hostsOf('http://[::1]:6333').hosts).toEqual(['::1']);
  });
});
