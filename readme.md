<h1 align="center">
  keyalesce
</h1>

<div align="center">
  <a href="https://npmjs.org/package/keyalesce">
    <img src="https://badgen.now.sh/npm/v/keyalesce" alt="version" />
  </a>
  <a href="https://github.com/TomerAberbach/keyalesce/actions">
    <img src="https://github.com/TomerAberbach/keyalesce/workflows/CI/badge.svg" alt="CI" />
  </a>
  <a href="https://unpkg.com/keyalesce/dist/index.js">
    <img src="https://deno.bundlejs.com/?q=keyalesce&badge" alt="gzip size" />
  </a>
  <a href="https://unpkg.com/keyalesce/dist/index.js">
    <img src="https://deno.bundlejs.com/?q=keyalesce&config={%22compression%22:{%22type%22:%22brotli%22}}&badge" alt="brotli size" />
  </a>
</div>

<div align="center">
  Get the same key for the same sequence of values!
</div>

## Features

- **Simple:** a single function that takes an array and returns a key
- **Tiny:** 580 bytes gzipped!
- **Performant:** maintains a regularly pruned internal
  [trie](https://en.wikipedia.org/wiki/Trie) of the value sequences

## When would I use this and how does it work?

[Read my post!](https://tomeraberba.ch/the-making-of-keyalesce)

## Install

```sh
$ npm i keyalesce
```

## Usage

```js
import keyalesce from 'keyalesce'

const hangouts = new Set()

const createHangoutKey = (person1, person2) =>
  keyalesce([person1, person2].sort())
const hangOut = (person1, person2) =>
  hangouts.add(createHangoutKey(person1, person2))
const didTheyHangOut = (person1, person2) =>
  hangouts.has(createHangoutKey(person1, person2))

hangOut(`Tomer`, `Samuel`)
hangOut(`Tomer`, `Amanda`)

console.log(didTheyHangOut(`Tomer`, `Samuel`))
console.log(didTheyHangOut(`Samuel`, `Tomer`))
//=> true
//=> true

console.log(didTheyHangOut(`Tomer`, `Amanda`))
console.log(didTheyHangOut(`Amanda`, `Tomer`))
//=> true
//=> true

console.log(didTheyHangOut(`Samuel`, `Amanda`))
console.log(didTheyHangOut(`Amanda`, `Samuel`))
//=> false
//=> false
```

## Contributing

Stars are always welcome!

For bugs and feature requests,
[please create an issue](https://github.com/TomerAberbach/keyalesce/issues/new).

For pull requests, please read the
[contributing guidelines](https://github.com/TomerAberbach/keyalesce/blob/main/contributing.md).

## License

[Apache License 2.0](https://github.com/TomerAberbach/keyalesce/blob/main/license)

This is not an official Google product.
