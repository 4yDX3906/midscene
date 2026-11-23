import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReportMeta, Result } from '@/benchmark-grounding/core/schemas';
import { buildChromeArgs } from '@midscene/web/puppeteer-agent-launcher';
import { expect, test } from '@rstest/core';
import { execa } from 'execa';
import puppeteer from 'puppeteer';
import {
  fixture,
  writeFixture,
} from '../unit-test/benchmark-grounding/fixture';

test('plots independent axes and supports scatter hover, focus, and navigation', async () => {
  const run = await mkdtemp(path.join(tmpdir(), 'grounding-scatter-'));
  try {
    const record = fixture();
    await writeFixture(path.join(run, 'testcases'), record);
    const models: NonNullable<ReportMeta['models']> = {};
    for (const [model, latency, correct] of [
      ['fast-and-correct', 1000, true],
      ['slow-and-incorrect', 4000, false],
    ] as const) {
      models[model] = {
        name: model,
        family: 'qwen3',
        displayName: model,
        reference: {
          source: 'Fixture',
          url: 'https://example.invalid',
          observedAt: '2026-11-23',
          performance: { responseLatencyMs: latency },
        },
      };
      const attempt: Result['attempts'][number] = {
        output: correct
          ? { type: 'POINT', correct, center: [0.5, 0.5] }
          : { type: 'REFUSAL', correct },
        profiling: { usageStatus: 'complete', calls: 1, durationMs: latency },
      };
      const result: Result = {
        schemaVersion: 1,
        consistency: { testcaseSha256: record.testcaseSha256 },
        input: {
          testcase: record.testcase.name,
          model,
          family: 'qwen3',
          displayName: model,
          platform: record.testcase.platform,
          instruction: record.testcase.instruction.en,
          groundTruth: record.testcase.groundTruth,
        },
        ...attempt,
        attempts: [attempt],
      };
      const directory = path.join(run, 'results', model);
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${record.testcase.name}.json`),
        JSON.stringify(result),
      );
    }
    await writeFile(
      path.join(run, 'meta.json'),
      JSON.stringify({ models, families: {} }),
    );
    await execa(process.execPath, [
      path.resolve(__dirname, '../../bin/midscene'),
      'model',
      'benchmark-grounding',
      'report',
      run,
      '--no-open',
    ]);

    const browser = await puppeteer.launch({
      args: buildChromeArgs(),
      defaultViewport: { width: 1400, height: 900 },
    });
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.url().startsWith('https:')) void request.abort();
        else void request.continue();
      });
      await page.goto(
        `${pathToFileURL(path.join(run, 'report.html'))}#/overview`,
      );
      const readDot = async (model: string) => {
        const selector = `[data-model="${model}"] .scatter-model-dot`;
        await page.waitForSelector(selector);
        return page.$eval(selector, (dot) => ({
          x: Number(dot.getAttribute('cx')),
          y: Number(dot.getAttribute('cy')),
        }));
      };
      const fast = await readDot('fast-and-correct');
      const slow = await readDot('slow-and-incorrect');
      expect(fast.x).toBeLessThan(slow.x);
      expect(fast.y).toBeLessThan(slow.y);

      const dot = '[data-model="fast-and-correct"] .scatter-model-dot';
      const slowCapsule =
        '[data-model="slow-and-incorrect"] .scatter-model-label';
      const tooltipTitle = '.performance-tooltip strong';
      for (const [selector, model] of [
        [dot, 'fast-and-correct'],
        [slowCapsule, 'slow-and-incorrect'],
      ]) {
        await page.mouse.move(0, 0);
        await page.waitForSelector(tooltipTitle, { hidden: true });
        await page.hover(selector);
        await page.waitForSelector(tooltipTitle, { visible: true });
        expect(
          await page.$eval(tooltipTitle, (title) => title.textContent),
        ).toBe(model);
      }

      const hasFocusOutline = () =>
        page.$eval('.model-scatter-plot', (plot) => {
          const active = document.activeElement;
          if (!active || !plot.contains(active)) return false;
          const { outlineStyle, outlineWidth } = getComputedStyle(active);
          return outlineStyle !== 'none' && Number.parseFloat(outlineWidth) > 0;
        });
      const openModel = async (selector: string, model: string) => {
        const detailHash = await page.$eval(
          `table a[aria-label="View details for ${model}"]`,
          (link) => link.getAttribute('href'),
        );
        const { x, y } = await page.$eval(selector, (element) => {
          const box = element.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });
        // Recharts can move the active marker to a different SVG layer on hover.
        await page.mouse.move(x, y);
        await page.mouse.down();
        expect(await hasFocusOutline()).toBe(false);
        await page.mouse.up();
        await page.waitForSelector('#case-name', { visible: true });
        expect(new URL(page.url()).hash).toBe(detailHash);
        expect(
          await page.$eval('#case-name', (heading) => heading.textContent),
        ).toBe(record.testcase.name);
        expect(
          await page.$eval(
            '[aria-label="Model results"] [aria-current="true"] > span',
            (selected) => selected.textContent,
          ),
        ).toBe(model);
      };
      await page.mouse.move(0, 0);
      for (let tab = 0; tab < 20 && !(await hasFocusOutline()); tab++) {
        await page.keyboard.press('Tab');
      }
      expect(await hasFocusOutline()).toBe(true);
      await openModel(dot, 'fast-and-correct');
      await page.goBack();
      await page.waitForSelector(slowCapsule, { visible: true });
      expect(new URL(page.url()).hash).toBe('#/overview');
      await openModel(slowCapsule, 'slow-and-incorrect');
    } finally {
      await browser.close();
    }
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});
