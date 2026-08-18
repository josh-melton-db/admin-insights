import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

export function KpiGrid({
  items,
}: {
  items: Array<{
    title: string;
    value: string;
    unit: string;
    period: string;
    source: string;
  }>;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.title}>
          <CardHeader>
            <CardTitle>{item.title}</CardTitle>
            <CardDescription>
              {item.unit} · {item.period}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold text-foreground">{item.value}</p>
            <p className="mt-2 text-xs text-muted-foreground">Source: {item.source}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
