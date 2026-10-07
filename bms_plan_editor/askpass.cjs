#!/usr/bin/env node
const prompt = process.argv[2] || ''
process.stdout.write(/username/i.test(prompt) ? 'x-access-token\n' : `${process.env.EDITOR_GITHUB_TOKEN || ''}\n`)
