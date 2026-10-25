import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {oneLine} from '../helpers/agentia-cli.ts'

describe('oneLine (joins CLI messages that oclif wrapped to the terminal width)', () => {
  it('joins the Windows » continuation lines as Agentia prints them on Windows', () => {
    const windows = ' »   Error: C:\\Users\\dev\\AppData\\Local\\Temp\\passport-agent-script-recipes-fqlkAZ is\r\n »   not inside a Git repository. Travel compares your story branch with the\r\n »   target branch.\r\n'
    assert.equal(oneLine(windows), 'Error: C:\\Users\\dev\\AppData\\Local\\Temp\\passport-agent-script-recipes-fqlkAZ is not inside a Git repository. Travel compares your story branch with the target branch.')
  })

  it('joins the Linux/macOS › continuation lines', () => {
    assert.equal(oneLine(' ›   Error: /tmp/x is not inside a Git \n ›   repository.\n'), 'Error: /tmp/x is not inside a Git repository.')
  })
})
