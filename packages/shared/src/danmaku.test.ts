import test from 'node:test'
import assert from 'node:assert/strict'
import {
  matchArchiveRange,
  matchBestEpisodeXml,
  sortDanmakuXmlFiles,
  parseDanmakuXml,
  deduplicateDanmakuIncremental,
  type DanmakuComment,
} from './danmaku'

test('matchArchiveRange correctly checks episode inclusion', () => {
  // Non-range titles always return true
  assert.equal(matchArchiveRange('寒蝉（两季+猫杀篇+礼+煌+扩）', 3), true)
  assert.equal(matchArchiveRange('月刊少女野崎君', 12), true)

  // Segmented range titles
  assert.equal(matchArchiveRange('航海王(海贼王)[1~225][爱奇艺·源]', 1), true)
  assert.equal(matchArchiveRange('航海王(海贼王)[1~225][爱奇艺·源]', 100), true)
  assert.equal(matchArchiveRange('航海王(海贼王)[1~225][爱奇艺·源]', 225), true)
  assert.equal(matchArchiveRange('航海王(海贼王)[1~225][爱奇艺·源]', 226), false)

  assert.equal(matchArchiveRange('航海王(海贼王)[226~450][爱奇艺·源]', 225), false)
  assert.equal(matchArchiveRange('航海王(海贼王)[226~450][爱奇艺·源]', 300), true)
  assert.equal(matchArchiveRange('航海王(海贼王)[226~450][爱奇艺·源]', 450), true)
  assert.equal(matchArchiveRange('航海王(海贼王)[226~450][爱奇艺·源]', 451), false)

  // Parenthesis and other separators
  assert.equal(matchArchiveRange('火影忍者 疾风传 (694-720)', 700), true)
  assert.equal(matchArchiveRange('火影忍者 疾风传 (694-720)', 600), false)

  assert.equal(matchArchiveRange('龙与虎【1-25话全】', 13), true)
  assert.equal(matchArchiveRange('龙与虎【1-25话全】', 26), false)
})

test('matchBestEpisodeXml picks the right episode from archive file list', () => {
  const files = [
    '第一季_第01话.xml',
    '第一季_第02话.xml',
    '第一季_第03话.xml',
    '第一季_第10话.xml',
    '第二季_第03话.xml',
  ]

  assert.equal(matchBestEpisodeXml(files, 3, '第一季'), '第一季_第03话.xml')
  assert.equal(matchBestEpisodeXml(files, 3, '第二季'), '第二季_第03话.xml')
  assert.equal(matchBestEpisodeXml(files, 1), '第一季_第01话.xml')
  assert.equal(matchBestEpisodeXml(files, 10), '第一季_第10话.xml')

  const epFormats = [
    'Bleach_EP03.xml',
    'Bleach_EP04.xml',
    'Bleach_E05.xml',
    'Bleach_P06.xml',
    '[07].xml',
  ]
  assert.equal(matchBestEpisodeXml(epFormats, 3), 'Bleach_EP03.xml')
  assert.equal(matchBestEpisodeXml(epFormats, 4), 'Bleach_EP04.xml')
  assert.equal(matchBestEpisodeXml(epFormats, 5), 'Bleach_E05.xml')
  assert.equal(matchBestEpisodeXml(epFormats, 6), 'Bleach_P06.xml')
  assert.equal(matchBestEpisodeXml(epFormats, 7), '[07].xml')
})

test('sortDanmakuXmlFiles sorts seasons and episode numbers naturally', () => {
  const disordered = [
    '第一季/10、第十集.Xml',
    '第一季/11、第十一集.Xml',
    '第一季/19、第十九集.Xml',
    '第一季/1、第一集.Xml',
    '第一季/20、第二十集.Xml',
    '第一季/2、第二集.Xml',
    '第二季/1、第一话.Xml',
    '第二季/10、第十话.Xml',
    '第二季/2、第二话.Xml',
    'OVA/01.xml',
  ]

  const sorted = sortDanmakuXmlFiles(disordered)
  assert.deepEqual(sorted, [
    '第一季/1、第一集.Xml',
    '第一季/2、第二集.Xml',
    '第一季/10、第十集.Xml',
    '第一季/11、第十一集.Xml',
    '第一季/19、第十九集.Xml',
    '第一季/20、第二十集.Xml',
    '第二季/1、第一话.Xml',
    '第二季/2、第二话.Xml',
    '第二季/10、第十话.Xml',
    'OVA/01.xml',
  ])
})

