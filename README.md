# petra

Embed a caching, reverse HTTP proxy into an existing ECMAScript 6 web application.

Features:

- Consistent hashing via the use of a hash ring
- Prevention of the thundering herd problem via a dogpile lock
- Respects upstream Cache-Control headers

Does not yet support:

- [ ] Upstream authentication
- [ ] Auto-discovery of nodes
- [ ] Caching of full response headers
- [ ] Use of If-Modified-Since

_This is alpha-quality software and is not yet ready for use in production environments._

## Usage example

```javascript
var Petra = require('petra');
var petra = new Petra({
  ring: ['192.168.1.1', '192.168.1.2', '192.168.1.3']
});
petra.fetch('http://api.upstream.com/resource', 'bucket-name', function(err, filename, created, expires) {
  // filename is the path to the local file containing the response
  // created is the Date when the response was originally cached
  // expires is the Date when the response will become stale
});
```

## API

### new Petra(options)

Where `options` is an Object containing:

#### ring

Required. The array of IP addresses in the HashRing. Private IP addresses can be used if all nodes are within the same VPC.

#### cacheDirectory

The directory in which to store cached items, defaulting to `/tmp/petra`.

#### port

The HTTP port for nodes within a ring to communicate, defaulting to 8209.

#### minimumTtl

The minimum TTL for cached items in seconds, defaults to 7 days.

The TTL for each response will be the minimum of this value or the max age of the upstream HTTP `Cache-Control` response header.

#### purgeStaleInterval

The interval in seconds between purges of stale content in the cache, defaults to 1 hour.

#### mediaTypes

An array of accepted `Content-Type` upstream response headers, defaulting to the empty list and therefore allowing any.

#### log

A function called for any warnings, defaults to `console.log` with a timestamp prefix.

#### debug

Enable debug to help trace peer/upstream problems, defaults to `false`.

### fetch(url, [bucket], callback)

Fetches a remote `url`, first checking with the local filesystem and the peer in the hash ring that "owns" the URL.

Optionally accepts a `bucket` String to partition data in the cache.

The `callback` function is passed `(err, filename, created, expires)` where:

- `err` is the error, if any.
- `filename` is the path to the local file containing the response.
- `created` is the Date when the response was originally cached.
- `expires` is the Date when the response will become stale.

### purge(url, [bucket], callback)

Removes cached copy of the URL, if any, from the local filesystem only.

## Licence

Copyright 2015 Lovell Fuller.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0.html)

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
