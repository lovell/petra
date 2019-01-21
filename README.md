# petra

Embed a reverse HTTP proxy into an existing ES6 application.

Features:

- Filesystem-backed cache
- Prevention of the thundering herd problem via a dogpile lock
- Respects upstream Cache-Control headers

Does not yet support:

- [ ] Upstream authentication
- [ ] Caching of full response headers
- [ ] Use of If-Modified-Since

_This is alpha-quality software and is not yet ready for use in production environments._

## Usage example

```javascript
import Petra from 'petra';
const petra = new Petra();
petra.fetch('http://api.upstream.com/resource', (err, filename, created, expires) => {
  // filename is the path to the local file containing the response
  // created is the Date when the response was originally cached
  // expires is the Date when the response will become stale
});
```

## API

### new Petra(options)

Where `options` is an Object containing:

#### cacheDirectory

The directory in which to store cached items, defaulting to `/tmp/petra`.

#### hash

A function to generate cache keys, defaults to SHA-256.

#### minimumTtl

The minimum TTL for cached items in seconds, defaults to 7 days.

The TTL for each response will be the minimum of this value or the max age of the upstream HTTP `Cache-Control` response header.

#### purgeStaleInterval

The interval in seconds between purges of stale content in the cache, defaults to 1 hour.

#### mediaTypes

An array of accepted `Content-Type` upstream response headers, defaulting to the empty list and therefore allowing any.

#### requestTimeout

The length of time to wait to connect to an upstream source, defaulting to 10000ms.

#### responseTimeout

The length of time to wait, after connecting, for an upstream source to provide data, defaulting to 10000ms.

#### userAgent

The `User-Agent` header for upstream requests, defaulting to `lovell/petra`.

#### debug

Enable debug to help trace peer/upstream problems, defaults to `false`.

#### log

The function to call with debug messages, defaults to `console.log`.

### fetch(url, callback)

Fetches a remote `url`, first checking with the local filesystem cache.

The `callback` function is passed `(err, filename, created, expires)` where:

- `err` is the error, if any.
- `filename` is the path to the cached file containing the response.
- `created` is the Date when the response was originally cached.
- `expires` is the Date when the response will become stale.

### purge(url, callback)

Removes cached copy of the URL, if any, from the local filesystem only.

## Licence

Copyright 2015, 2016, 2017, 2018, 2019 Lovell Fuller.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0.html)

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
