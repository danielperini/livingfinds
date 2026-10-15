import { buildOrder, EntityRepo } from './entities.ts';

Deno.test('entity ordering keeps ascending/descending requests stable with an ID tie-breaker', () => {
  if (buildOrder('updated_date') !== 'ORDER BY "updated_date" ASC, id ASC') {
    throw new Error('ascending order or stable tie-breaker changed');
  }
  if (buildOrder('-updated_date') !== 'ORDER BY "updated_date" DESC, id ASC') {
    throw new Error('descending order or stable tie-breaker changed');
  }
  if (buildOrder('spend') !== `ORDER BY (data->'spend') ASC NULLS LAST, id ASC`) {
    throw new Error('JSON field order changed');
  }
});

Deno.test('reproduces sort.startsWith is not a function at the Hostinger entity boundary and returns a clear contract error', async () => {
  const repo = new EntityRepo('Campaign');
  try {
    // This was the invalid shape reaching buildOrder before the boundary guard.
    await repo.filter(
      { amazon_account_id: 'test-account' },
      { sort: '-updated_at' } as unknown as string,
      20,
      0,
    );
    throw new Error('expected invalid sort shape to fail');
  } catch (error) {
    const message = String((error as Error).message || error);
    if (
      !(error instanceof TypeError) || !message.includes('sort deve ser string ou null') ||
      message.includes('startsWith is not a function')
    ) {
      throw error;
    }
  }
});

Deno.test('entity filter accepts only the documented positional sort value type', async () => {
  const repo = new EntityRepo('Campaign');
  for (const invalid of [{ sort: '-updated_at' }, ['-updated_at'], 42]) {
    try {
      await repo.filter({}, invalid as unknown as string, 20, 0);
      throw new Error('expected invalid sort argument to fail');
    } catch (error) {
      if (
        !(error instanceof TypeError) ||
        !String((error as Error).message).includes('sort deve ser string ou null')
      ) throw error;
    }
  }
});
