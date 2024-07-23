/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars */
import clickhouse from 'lib/clickhouse';
import { EVENT_TYPE, FILTER_COLUMNS, SESSION_COLUMNS } from 'lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from 'lib/db';
import prisma from 'lib/prisma';
import { QueryFilters } from 'lib/types';

export async function getPageviewMetrics(
  ...args: [
    websiteId: string,
    type: string,
    filters: QueryFilters,
    limit?: number,
    offset?: number,
    unit?: string,
  ]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  type: string,
  filters: QueryFilters,
  limit: number = 500,
  offset: number = 0,
  unit: string,
) {
  const column = FILTER_COLUMNS[type] || type;
  const { rawQuery, parseFilters } = prisma;
  const { filterQuery, joinSession, params } = await parseFilters(
    websiteId,
    {
      ...filters,
      eventType: column === 'event_name' ? EVENT_TYPE.customEvent : EVENT_TYPE.pageView,
    },
    { joinSession: SESSION_COLUMNS.includes(type) },
  );

  let entryExitQuery = '';
  let excludeDomain = '';
  if (column === 'referrer_domain') {
    excludeDomain = `and website_event.referrer_domain != {{websiteDomain}}
      and website_event.referrer_domain is not null`;
  }

  if (type === 'entry' || type === 'exit') {
    const aggregrate = type === 'entry' ? 'min' : 'max';

    entryExitQuery = `
      join (
        select visit_id,
            ${aggregrate}(created_at) target_created_at
        from website_event
        where website_event.website_id = {{websiteId::uuid}}
          and website_event.created_at between {{startDate}} and {{endDate}}
          and event_type = {{eventType}}
        group by visit_id
      ) x
      on x.visit_id = website_event.visit_id
          and x.target_created_at = website_event.created_at
    `;
  }

  return rawQuery(
    `
    select ${column} x, count(*) y
    from website_event
    ${joinSession}
    ${entryExitQuery}
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and event_type = {{eventType}}
      ${excludeDomain}
      ${filterQuery}
    group by 1
    order by 2 desc
    limit ${limit}
    offset ${offset}
    `,
    params,
  );
}

async function clickhouseQuery(
  websiteId: string,
  type: string,
  filters: QueryFilters,
  limit: number = 500,
  offset: number = 0,
  unit: string,
): Promise<{ x: string; y: number }[]> {
  const column = FILTER_COLUMNS[type] || type;
  const { rawQuery, parseFilters } = clickhouse;
  const { filterQuery, params } = await parseFilters(websiteId, {
    ...filters,
    eventType: column === 'event_name' ? EVENT_TYPE.customEvent : EVENT_TYPE.pageView,
  });

  let excludeDomain = '';
  let groupByQuery = '';

  if (column === 'referrer_domain') {
    excludeDomain = `and t != {websiteDomain:String} and t != ''`;
  }

  let columnQuery = `arrayJoin(${column})`;

  if (type === 'entry') {
    columnQuery = `visit_id x, argMinMerge(${column})`;
  }

  if (type === 'exit') {
    columnQuery = `visit_id x, argMaxMerge(${column})`;
  }

  if (type === 'entry' || type === 'exit') {
    groupByQuery = 'group by x';
  }

  const table = unit === 'hour' ? 'website_event_stats_hourly' : 'website_event_stats_daily';

  return rawQuery(
    `
    select g.t as x,
      count(*) as y
    from (
      select ${columnQuery} as t
      from ${table} website_event
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = {eventType:UInt32}
        ${excludeDomain}
        ${filterQuery}
      ${groupByQuery}) as g
    group by x
    order by y desc
    limit ${limit}
    offset ${offset}
    `,
    params,
  ).then((result: any) => {
    return Object.values(result).map((a: any) => {
      return { x: a.x, y: Number(a.y) };
    });
  });
}
